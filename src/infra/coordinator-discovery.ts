import { dirname } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import type { CoralPaths } from './path/compose.js';
import type { EnvPort, StoragePort } from './port-types.js';
import { probeProcessStartedAtSeconds } from './node-process.js';
import { isNoEntryError } from './fs-errors.js';

export interface CoordinatorDiscoveryRecord {
  pid: number;
  port: number;
  socketPath: string;
  bundleHash: string;
  flavor: BuildFlavor;
  namespace: string;
  startedAt: number;
  token: string;
  host?: string;
  version?: string;
  instanceId?: string;
  processStartedAt?: number;
}

export interface CoordinatorInfo extends CoordinatorDiscoveryRecord {
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

function normalizeDiscoveryRecord(value: unknown): CoordinatorDiscoveryRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const pid = Number.isInteger(record.pid) && (record.pid as number) > 0 ? (record.pid as number) : null;
  const port = Number.isInteger(record.port) && (record.port as number) > 0 ? (record.port as number) : null;
  const socketPath =
    typeof record.socketPath === 'string' && record.socketPath.length > 0 ? record.socketPath : null;
  const bundleHash =
    typeof record.bundleHash === 'string' && record.bundleHash.length > 0 ? record.bundleHash : null;
  const flavor = record.flavor === 'prod' || record.flavor === 'dev' ? record.flavor : null;
  const namespace =
    typeof record.namespace === 'string' && record.namespace.length > 0 ? record.namespace : null;
  const startedAt =
    Number.isFinite(record.startedAt) && (record.startedAt as number) > 0 ? (record.startedAt as number) : null;
  const token = typeof record.token === 'string' && record.token.length > 0 ? record.token : null;
  const host =
    record.host === undefined
      ? undefined
      : typeof record.host === 'string' && record.host.length > 0
        ? record.host
        : null;
  const version =
    record.version === undefined
      ? undefined
      : typeof record.version === 'string' && record.version.length > 0
        ? record.version
        : null;
  const instanceId =
    record.instanceId === undefined
      ? undefined
      : typeof record.instanceId === 'string' && record.instanceId.length > 0
        ? record.instanceId
        : null;
  const processStartedAt =
    record.processStartedAt === undefined
      ? undefined
      : Number.isInteger(record.processStartedAt) && (record.processStartedAt as number) > 0
        ? (record.processStartedAt as number)
        : null;

  if (
    pid === null ||
    port === null ||
    socketPath === null ||
    bundleHash === null ||
    flavor === null ||
    namespace === null ||
    startedAt === null ||
    token === null ||
    host === null ||
    version === null ||
    instanceId === null ||
    processStartedAt === null
  ) {
    return null;
  }

  const normalized: CoordinatorDiscoveryRecord = {
    pid,
    port,
    socketPath,
    bundleHash,
    flavor,
    namespace,
    startedAt,
    token,
  };
  if (host !== undefined) normalized.host = host;
  if (version !== undefined) normalized.version = version;
  if (instanceId !== undefined) normalized.instanceId = instanceId;
  if (processStartedAt !== undefined) normalized.processStartedAt = processStartedAt;
  return normalized;
}

function discoveryFilePath(runtime: DiscoveryRuntime): string {
  return runtime.paths.coral.coordinator.infoFile;
}

export function writeDiscoveryRecord(
  record: CoordinatorDiscoveryRecord,
  runtime: DiscoveryRuntime,
): void {
  const infoPath = discoveryFilePath(runtime);
  const payload = JSON.stringify({
    ...record,
    processStartedAt:
      record.processStartedAt
      ?? probeProcessStartedAtSeconds(record.pid, runtime.env.platform() as NodeJS.Platform)
      ?? undefined,
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

export function writeCoordinatorInfo(info: CoordinatorInfo, runtime: DiscoveryRuntime): void {
  writeDiscoveryRecord(info, runtime);
}

export function readCoordinatorInfo(runtime: DiscoveryRuntime): CoordinatorInfo | null {
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

export function removeCoordinatorInfoIfOwner(owner: string, runtime: DiscoveryRuntime): void {
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
