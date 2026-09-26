import { join } from 'node:path';
import { z } from 'zod';

import type { StrictBundleManifest } from '../../infra/bundle-manifest.js';
import type { Runtime } from '../../runtime/ports.js';
import { observeSuccessionServing } from '../../store/succession-writer-generation.js';

const openSchema = z
  .object({
    version: z.literal('v1'),
    epochKey: z.string().min(1),
    instanceId: z.string().min(1),
    attemptId: z.string().uuid().nullable(),
    pluginRoot: z.string().min(1),
    build: z.object({
      version: z.string(),
      buildSetId: z.string(),
      flavor: z.enum(['dev', 'prod']),
      storeFormatFingerprint: z.string(),
      bundleHash: z.string(),
      cliBundleHash: z.string(),
      claudeAppserverBundleHash: z.string(),
      durableWrapperBundleHash: z.string(),
    }),
    controlGeneration: z.number().int().nonnegative(),
    openedAtMs: z.number().int().nonnegative(),
  })
  .passthrough();
const servingSchema = z
  .object({
    version: z.literal('v1'),
    attemptId: z.string().uuid(),
    epochKey: z.string().min(1),
    successorInstanceId: z.string().min(1),
    controlGeneration: z.number().int().positive(),
  })
  .passthrough();

export type ControllerOpen = z.infer<typeof openSchema>;

/** Unreadable records are named, never folded into absence: one of them may be the latest controller. */
export type ControllerOpenObservation = Readonly<{
  latest: ControllerOpen | null;
  unreadable: readonly string[];
}>;

function epochDirectory(runtime: Runtime, epochKey: string): string {
  return join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1', runtime.ids.sha256(epochKey));
}

function syncDirectory(runtime: Runtime, path: string): void {
  if (!runtime.storage.syncDirectoryDurableSync(path)) throw new Error(`Could not sync directory: ${path}`);
}

function controllerRoot(runtime: Runtime): string {
  return join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1');
}

type ControllerServingRead =
  | Readonly<{ kind: 'recorded'; serving: z.infer<typeof servingSchema> }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable' }>;

function servingPath(runtime: Runtime, attemptId: string): string {
  return join(controllerRoot(runtime), 'served', `${attemptId}.json`);
}

function readControllerServing(runtime: Runtime, attemptId: string): ControllerServingRead {
  let raw: string;
  try {
    raw = runtime.storage.readFileSync(servingPath(runtime, attemptId), 'utf-8');
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
  const parsed = servingSchema.safeParse(parseJson(raw));
  return parsed.success ? { kind: 'recorded', serving: parsed.data } : { kind: 'unreadable' };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function recordControllerServing(
  runtime: Runtime,
  attemptId: string,
  epochKey: string,
  instanceId: string,
  controlGeneration: number,
): void {
  const directory = join(controllerRoot(runtime), 'served');
  runtime.storage.mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(runtime, controllerRoot(runtime));
  const record = servingSchema.parse({
    version: 'v1',
    attemptId,
    epochKey,
    successorInstanceId: instanceId,
    controlGeneration,
  });
  const path = join(directory, `${attemptId}.json`);
  if (!runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })) {
    throw new Error(`Could not record controller serving: ${path}`);
  }
}

export function recordControllerOpen(
  runtime: Runtime,
  epochKey: string,
  instanceId: string,
  attemptId: string | null,
  pluginRoot: string,
  build: StrictBundleManifest,
  controlGeneration: number,
): void {
  const directory = epochDirectory(runtime, epochKey);
  const root = controllerRoot(runtime);
  runtime.storage.mkdirSync(root, { recursive: true, mode: 0o700 });
  syncDirectory(runtime, runtime.paths.coral.coordinator.runDir);
  runtime.storage.mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(runtime, root);
  const record = openSchema.parse({
    version: 'v1',
    epochKey,
    instanceId,
    attemptId,
    pluginRoot,
    build,
    controlGeneration,
    openedAtMs: runtime.time.now(),
  });
  const path = join(directory, `${record.openedAtMs}-${runtime.ids.uuid()}.json`);
  if (!runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })) {
    throw new Error(`Could not record controller open: ${path}`);
  }
}

export function latestControllerOpen(
  runtime: Runtime,
  epochKey: string,
  instanceId?: string,
): ControllerOpenObservation {
  const directory = epochDirectory(runtime, epochKey);
  let names: string[];
  try {
    names = runtime.storage.readdirSync(directory);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { latest: null, unreadable: [] };
    return { latest: null, unreadable: [directory] };
  }
  let latest: ControllerOpen | null = null;
  const unreadable: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    let raw: string;
    try {
      raw = runtime.storage.readFileSync(path, 'utf-8');
    } catch {
      unreadable.push(path);
      continue;
    }
    const parsed = openSchema.safeParse(parseJson(raw));
    if (!parsed.success || parsed.data.epochKey !== epochKey) {
      unreadable.push(path);
      continue;
    }
    const record = parsed.data;
    if (instanceId !== undefined && record.instanceId !== instanceId) continue;
    if (record.attemptId !== null) {
      const recorded = readControllerServing(runtime, record.attemptId);
      if (recorded.kind === 'unreadable') {
        unreadable.push(servingPath(runtime, record.attemptId));
        continue;
      }
      let serving: Readonly<{ epochKey: string; successorInstanceId: string; controlGeneration: number }> | null;
      try {
        serving = recorded.kind === 'recorded' ? recorded.serving : observeSuccessionServing(runtime, record.attemptId);
      } catch {
        unreadable.push(servingPath(runtime, record.attemptId));
        continue;
      }
      if (
        serving?.epochKey !== epochKey ||
        serving.successorInstanceId !== record.instanceId ||
        serving.controlGeneration !== record.controlGeneration
      )
        continue;
    }
    if (
      latest === null ||
      record.controlGeneration > latest.controlGeneration ||
      (record.controlGeneration === latest.controlGeneration && record.openedAtMs > latest.openedAtMs)
    ) {
      latest = record;
    }
  }
  return { latest, unreadable };
}
