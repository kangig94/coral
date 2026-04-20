import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BuildFlavor } from '../runtime/flavor.js';
import type { RuntimeEnvPort, RuntimeStoragePort } from '../runtime/ports.js';
import { probeProcessStartedAtSeconds as sharedProbeProcessStartedAtSeconds } from '../shared/node-process.js';
import { isNoEntryError } from '../shared/utils.js';
import { readBuildFlavor } from '../shared/utils.js';
import { coordinatorPaths } from './paths.js';

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

export interface BackendInfo extends CoordinatorDiscoveryRecord {
  host: string;
  version: string;
  instanceId: string;
}

type DiscoveryStorage = Pick<
  RuntimeStoragePort,
  'chmodSync' | 'mkdirSync' | 'readFileSync' | 'unlinkSync' | 'writeAtomicSync'
>;
type DiscoveryEnv = Pick<RuntimeEnvPort, 'platform'>;
type DiscoveryRuntime = {
  storage: DiscoveryStorage;
  env?: DiscoveryEnv;
};

const DEFAULT_DISCOVERY_HOST = '127.0.0.1';
export const probeProcessStartedAtSeconds = sharedProbeProcessStartedAtSeconds;

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
  const flavor =
    record.flavor === undefined
      ? 'prod'
      : record.flavor === 'prod' || record.flavor === 'dev'
        ? record.flavor
        : null;
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

function defaultStorage(): DiscoveryStorage {
  return {
    chmodSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeAtomicSync: (path, data, options) => {
      const tempPath = `${path}.tmp`;
      try {
        writeFileSync(tempPath, data, options);
        renameSync(tempPath, path);
        return true;
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function defaultEnv(): DiscoveryEnv {
  return { platform: () => process.platform };
}

function resolveDiscoveryRuntime(runtime?: DiscoveryRuntime): Required<DiscoveryRuntime> {
  return {
    storage: runtime?.storage ?? defaultStorage(),
    env: runtime?.env ?? defaultEnv(),
  };
}

function discoveryFilePath(flavor: BuildFlavor): string {
  return coordinatorPaths(flavor).infoFile;
}

function flavorForPluginRoot(pluginRoot: string): BuildFlavor {
  return readBuildFlavor(pluginRoot);
}

export function backendInfoPath(pluginRoot: string): string {
  return discoveryFilePath(flavorForPluginRoot(pluginRoot));
}

export function writeDiscoveryRecord(
  flavor: BuildFlavor,
  record: CoordinatorDiscoveryRecord,
  runtime?: DiscoveryRuntime,
): void {
  const deps = resolveDiscoveryRuntime(runtime);
  const infoPath = discoveryFilePath(flavor);
  const payload = JSON.stringify({
    ...record,
    processStartedAt:
      record.processStartedAt
      ?? probeProcessStartedAtSeconds(record.pid, deps.env.platform() as NodeJS.Platform)
      ?? undefined,
  });

  deps.storage.mkdirSync(dirname(infoPath), { recursive: true });
  if (!deps.storage.writeAtomicSync(infoPath, payload, { encoding: 'utf-8', mode: 0o600 })) {
    return;
  }
  if (deps.env.platform() !== 'win32') {
    try {
      deps.storage.chmodSync(infoPath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}

export function readDiscoveryRecord(
  flavor: BuildFlavor,
  runtime?: DiscoveryRuntime,
): CoordinatorDiscoveryRecord | null {
  const deps = resolveDiscoveryRuntime(runtime);

  try {
    const raw = deps.storage.readFileSync(discoveryFilePath(flavor), 'utf-8');
    return normalizeDiscoveryRecord(JSON.parse(raw));
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export function removeDiscoveryRecordIfOwner(
  flavor: BuildFlavor,
  owner: string,
  runtime?: DiscoveryRuntime,
): void {
  const deps = resolveDiscoveryRuntime(runtime);
  const record = readDiscoveryRecord(flavor, deps);
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
    deps.storage.unlinkSync(discoveryFilePath(flavor));
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
}

export function probeCoordinator(
  flavor: BuildFlavor,
  runtime?: DiscoveryRuntime,
): CoordinatorDiscoveryRecord | null {
  const deps = resolveDiscoveryRuntime(runtime);
  const record = readDiscoveryRecord(flavor, deps);
  if (!record) {
    return null;
  }

  const liveProcessStartedAt = probeProcessStartedAtSeconds(record.pid, deps.env.platform() as NodeJS.Platform);
  if (liveProcessStartedAt === null) {
    return null;
  }

  if (record.processStartedAt !== undefined && record.processStartedAt !== liveProcessStartedAt) {
    return null;
  }

  return record;
}

export function writeBackendInfo(
  pluginRoot: string,
  info: BackendInfo,
  runtime?: DiscoveryRuntime,
): void {
  const deps = resolveDiscoveryRuntime(runtime);
  writeDiscoveryRecord(flavorForPluginRoot(pluginRoot), info, deps);
}

export function readBackendInfo(
  pluginRoot: string,
  runtime?: DiscoveryRuntime,
): BackendInfo | null {
  const record = readDiscoveryRecord(flavorForPluginRoot(pluginRoot), runtime);
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

export function removeBackendInfoIfOwner(
  pluginRoot: string,
  owner: string,
  runtime?: DiscoveryRuntime,
): void {
  removeDiscoveryRecordIfOwner(flavorForPluginRoot(pluginRoot), owner, runtime);
}
