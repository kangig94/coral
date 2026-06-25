import { dirname } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import type { CoralPaths } from './path/index.js';
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNonEmptyString(value: unknown): string | null | undefined {
  return value === undefined ? undefined : nonEmptyString(value);
}

function positiveNumber(value: unknown): number | null {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function optionalPositiveInteger(value: unknown): number | null | undefined {
  return value === undefined ? undefined : positiveInteger(value);
}

function normalizeDiscoveryRecord(value: unknown): CoordinatorDiscoveryRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const pid = positiveInteger(record.pid);
  const port = positiveInteger(record.port);
  const socketPath = nonEmptyString(record.socketPath);
  const bundleHash = nonEmptyString(record.bundleHash);
  const flavor = record.flavor === 'prod' || record.flavor === 'dev' ? record.flavor : null;
  const namespace = nonEmptyString(record.namespace);
  const startedAt = positiveNumber(record.startedAt);
  const token = nonEmptyString(record.token);
  const shutdownToken = optionalNonEmptyString(record.shutdownToken);
  const host = optionalNonEmptyString(record.host);
  const version = optionalNonEmptyString(record.version);
  const instanceId = optionalNonEmptyString(record.instanceId);
  const processStartedAt = optionalPositiveInteger(record.processStartedAt);

  if (
    pid === null ||
    port === null ||
    socketPath === null ||
    bundleHash === null ||
    flavor === null ||
    namespace === null ||
    startedAt === null ||
    token === null ||
    shutdownToken === null ||
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
  if (shutdownToken !== undefined) normalized.shutdownToken = shutdownToken;
  if (host !== undefined) normalized.host = host;
  if (version !== undefined) normalized.version = version;
  if (instanceId !== undefined) normalized.instanceId = instanceId;
  if (processStartedAt !== undefined) normalized.processStartedAt = processStartedAt;
  return normalized;
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
