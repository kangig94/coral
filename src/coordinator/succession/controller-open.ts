import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { StrictBundleManifest } from '../../infra/bundle-manifest.js';
import type { Runtime } from '../../runtime/ports.js';
import { observeSuccessionServing } from '../../store/succession-writer-generation.js';

const openSchema = z.object({
  version: z.literal('v1'),
  epochKey: z.string().min(1),
  instanceId: z.string().min(1),
  attemptId: z.string().uuid().nullable(),
  pluginRoot: z.string().min(1),
  build: z.object({
    version: z.string(), buildSetId: z.string(), flavor: z.enum(['dev', 'prod']),
    storeFormatFingerprint: z.string(), bundleHash: z.string(), cliBundleHash: z.string(),
    claudeAppserverBundleHash: z.string(), durableWrapperBundleHash: z.string(),
  }),
  controlGeneration: z.number().int().nonnegative(),
  openedAtMs: z.number().int().nonnegative(),
}).strict();
const servingSchema = z.object({
  version: z.literal('v1'), attemptId: z.string().uuid(), epochKey: z.string().min(1),
  successorInstanceId: z.string().min(1), controlGeneration: z.number().int().positive(),
}).strict();

export type ControllerOpen = z.infer<typeof openSchema>;

function epochDirectory(runtime: Runtime, epochKey: string): string {
  return join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1', Buffer.from(epochKey).toString('base64url'));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function controllerRoot(runtime: Runtime): string {
  return join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1');
}

function readControllerServing(runtime: Runtime, attemptId: string): z.infer<typeof servingSchema> | null {
  try {
    return servingSchema.parse(JSON.parse(readFileSync(
      join(controllerRoot(runtime), 'served', `${attemptId}.json`), 'utf8')) as unknown);
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
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(controllerRoot(runtime));
  const record = servingSchema.parse({
    version: 'v1', attemptId, epochKey, successorInstanceId: instanceId, controlGeneration,
  });
  const path = join(directory, `${attemptId}.json`);
  const stage = `${path}.stage.${randomUUID()}`;
  const fd = openSync(stage, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(stage, path);
  syncDirectory(directory);
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
  mkdirSync(root, { recursive: true, mode: 0o700 });
  syncDirectory(runtime.paths.coral.coordinator.runDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(root);
  const record = openSchema.parse({
    version: 'v1', epochKey, instanceId, attemptId, pluginRoot, build,
    controlGeneration, openedAtMs: runtime.time.now(),
  });
  const name = `${record.openedAtMs}-${randomUUID()}.json`;
  const stage = join(directory, `.${name}.stage`);
  const fd = openSync(stage, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stage, join(directory, name));
  syncDirectory(directory);
}

export function latestControllerOpen(
  runtime: Runtime,
  epochKey: string,
  instanceId?: string,
): ControllerOpen | null {
  const directory = epochDirectory(runtime, epochKey);
  if (!existsSync(directory)) return null;
  let latest: ControllerOpen | null = null;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const parsed = openSchema.safeParse(JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown);
    if (!parsed.success || parsed.data.epochKey !== epochKey) throw new Error('Controller-open record is invalid.');
    const record = parsed.data;
    if (instanceId !== undefined && record.instanceId !== instanceId) continue;
    if (record.attemptId !== null) {
      const serving = readControllerServing(runtime, record.attemptId) ??
        observeSuccessionServing(runtime, record.attemptId);
      if (serving?.epochKey !== epochKey || serving.successorInstanceId !== record.instanceId ||
          serving.controlGeneration !== record.controlGeneration) continue;
    }
    if (latest === null || record.controlGeneration > latest.controlGeneration ||
        (record.controlGeneration === latest.controlGeneration && record.openedAtMs > latest.openedAtMs)) {
      latest = record;
    }
  }
  return latest;
}
