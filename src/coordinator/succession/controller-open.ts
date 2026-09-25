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
  .strict();
const servingSchema = z
  .object({
    version: z.literal('v1'),
    attemptId: z.string().uuid(),
    epochKey: z.string().min(1),
    successorInstanceId: z.string().min(1),
    controlGeneration: z.number().int().positive(),
  })
  .strict();

export type ControllerOpen = z.infer<typeof openSchema>;

function epochDirectory(runtime: Runtime, epochKey: string): string {
  return join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1', runtime.ids.sha256(epochKey));
}

function syncDirectory(runtime: Runtime, path: string): void {
  if (!runtime.storage.syncDirectoryDurableSync(path)) throw new Error(`Could not sync directory: ${path}`);
}

function controllerRoot(runtime: Runtime): string {
  return join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1');
}

function readControllerServing(runtime: Runtime, attemptId: string): z.infer<typeof servingSchema> | null {
  try {
    return servingSchema.parse(
      JSON.parse(
        runtime.storage.readFileSync(join(controllerRoot(runtime), 'served', `${attemptId}.json`), 'utf-8'),
      ) as unknown,
    );
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
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

export function latestControllerOpen(runtime: Runtime, epochKey: string, instanceId?: string): ControllerOpen | null {
  const directory = epochDirectory(runtime, epochKey);
  if (!runtime.storage.existsSync(directory)) return null;
  let latest: ControllerOpen | null = null;
  for (const name of runtime.storage.readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const parsed = openSchema.safeParse(
      JSON.parse(runtime.storage.readFileSync(join(directory, name), 'utf-8')) as unknown,
    );
    if (!parsed.success || parsed.data.epochKey !== epochKey) throw new Error('Controller-open record is invalid.');
    const record = parsed.data;
    if (instanceId !== undefined && record.instanceId !== instanceId) continue;
    if (record.attemptId !== null) {
      const serving =
        readControllerServing(runtime, record.attemptId) ?? observeSuccessionServing(runtime, record.attemptId);
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
  return latest;
}
