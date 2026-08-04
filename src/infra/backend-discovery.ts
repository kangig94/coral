import { dirname } from 'node:path';
import { z } from 'zod';

import type { BuildFlavor } from './build-flavor.js';
import type { CoralPaths } from './path/index.js';
import type { EnvPort, StoragePort } from './port-types.js';
import { probeProcessStartedAtSeconds } from './node-process.js';
import { isNoEntryError } from './fs-errors.js';

/** Connection and authentication evidence only; executable identity comes from authenticated health. */
export interface CoordinatorDiscoveryRecord {
  pid: number;
  port: number;
  socketPath: string;
  bundleHash: string;
  flavor: BuildFlavor;
  namespace: string;
  startedAt: number;
  token: string;
  bootToken: string;
  shutdownToken?: string;
  host?: string;
  version?: string;
  instanceId?: string;
  processStartedAt?: number;
}

export interface BackendInfo extends CoordinatorDiscoveryRecord {
  host: string;
  version: string;
  instanceId: string;
}

type DiscoveryStorage = Pick<
  StoragePort,
  'chmodSync' | 'mkdirSync' | 'readFileSync' | 'unlinkSync' | 'writeAtomicSync'
>;
type DiscoveryEnv = Pick<EnvPort, 'platform'>;
export type DiscoveryRuntime = {
  storage: DiscoveryStorage;
  env: DiscoveryEnv;
  paths: { readonly coral: CoralPaths };
};

const DEFAULT_DISCOVERY_HOST = '127.0.0.1';

const nonEmptyStringSchema = z.string().min(1);
const positiveIntegerSchema = z.number().int().positive();
const coordinatorDiscoveryRecordSchema = z
  .object({
    pid: positiveIntegerSchema,
    port: positiveIntegerSchema,
    socketPath: nonEmptyStringSchema,
    bundleHash: nonEmptyStringSchema,
    flavor: z.enum(['prod', 'dev']),
    namespace: nonEmptyStringSchema,
    startedAt: z.number().positive(),
    token: nonEmptyStringSchema,
    bootToken: nonEmptyStringSchema,
    shutdownToken: nonEmptyStringSchema.optional(),
    host: nonEmptyStringSchema.optional(),
    version: nonEmptyStringSchema.optional(),
    instanceId: nonEmptyStringSchema.optional(),
    processStartedAt: positiveIntegerSchema.optional(),
  })
  .strict();

function normalizeDiscoveryRecord(value: unknown): CoordinatorDiscoveryRecord | null {
  const parsed = coordinatorDiscoveryRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function discoveryFilePath(runtime: DiscoveryRuntime): string {
  return runtime.paths.coral.coordinator.infoFile;
}

export function writeDiscoveryRecord(record: CoordinatorDiscoveryRecord, runtime: DiscoveryRuntime): void {
  const infoPath = discoveryFilePath(runtime);
  const payload = JSON.stringify({
    ...record,
    processStartedAt:
      record.processStartedAt ??
      probeProcessStartedAtSeconds(record.pid, runtime.env.platform() as NodeJS.Platform) ??
      undefined,
  });

  runtime.storage.mkdirSync(dirname(infoPath), { recursive: true });
  if (!runtime.storage.writeAtomicSync(infoPath, payload, { encoding: 'utf-8', mode: 0o600 })) {
    return;
  }
  if (runtime.env.platform() !== 'win32') {
    try {
      runtime.storage.chmodSync(infoPath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}

export function readDiscoveryRecord(runtime: DiscoveryRuntime): CoordinatorDiscoveryRecord | null {
  try {
    const raw = runtime.storage.readFileSync(discoveryFilePath(runtime), 'utf-8');
    return normalizeDiscoveryRecord(JSON.parse(raw));
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export function probeCoordinator(runtime: DiscoveryRuntime): CoordinatorDiscoveryRecord | null {
  const record = readDiscoveryRecord(runtime);
  if (!record) {
    return null;
  }

  const liveProcessStartedAt = probeProcessStartedAtSeconds(record.pid, runtime.env.platform() as NodeJS.Platform);
  if (liveProcessStartedAt === null) {
    return null;
  }

  if (record.processStartedAt !== undefined && record.processStartedAt !== liveProcessStartedAt) {
    return null;
  }

  return record;
}

export function writeBackendInfo(info: BackendInfo, runtime: DiscoveryRuntime): void {
  writeDiscoveryRecord(info, runtime);
}

export function readBackendInfo(runtime: DiscoveryRuntime): BackendInfo | null {
  const record = readDiscoveryRecord(runtime);
  if (!record || record.version === undefined || record.instanceId === undefined) {
    return null;
  }

  return {
    ...record,
    host: record.host ?? DEFAULT_DISCOVERY_HOST,
    version: record.version,
    instanceId: record.instanceId,
  };
}

export function removeBackendInfoIfOwner(owner: string, runtime: DiscoveryRuntime): void {
  const record = readDiscoveryRecord(runtime);
  if (!record) {
    return;
  }

  if (record.instanceId !== undefined) {
    if (record.instanceId !== owner) {
      return;
    }
  } else if (record.token !== owner) {
    return;
  }

  try {
    runtime.storage.unlinkSync(discoveryFilePath(runtime));
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
}
