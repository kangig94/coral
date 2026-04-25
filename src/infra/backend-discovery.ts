import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import type { CoralPaths } from './coral-paths.js';
import type { InfraEnvPort, InfraStoragePort } from './port-types.js';
import { probeProcessStartedAtSeconds } from './node-process.js';
import { isNoEntryError } from './fs-errors.js';
import { readBuildFlavor } from './bundle-manifest.js';
import { coordinatorPaths } from './coordinator-paths.js';

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
  InfraStoragePort,
  'chmodSync' | 'mkdirSync' | 'readFileSync' | 'unlinkSync' | 'writeAtomicSync'
>;
type DiscoveryEnv = Pick<InfraEnvPort, 'platform'> & Partial<Pick<InfraEnvPort, 'fullSnapshot' | 'homedir'>>;
type DiscoveryRuntime = {
  storage: DiscoveryStorage;
  env?: DiscoveryEnv;
  paths?: { readonly coral: CoralPaths };
};
type ResolvedDiscoveryRuntime = {
  storage: DiscoveryStorage;
  env: DiscoveryEnv;
  paths?: { readonly coral: CoralPaths };
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
  return {
    fullSnapshot: () =>
      Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    homedir,
    platform: () => process.platform,
  };
}

function resolveDiscoveryRuntime(runtime?: DiscoveryRuntime): ResolvedDiscoveryRuntime {
  return {
    storage: runtime?.storage ?? defaultStorage(),
    env: runtime?.env ?? defaultEnv(),
    ...(runtime?.paths === undefined ? {} : { paths: runtime.paths }),
  };
}

function isFlavorNotSettledError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'E_FLAVOR_NOT_SETTLED'
  );
}

function discoveryFilePath(flavor: BuildFlavor, runtime?: Pick<ResolvedDiscoveryRuntime, 'env' | 'paths'>): string {
  if (runtime?.paths !== undefined) {
    try {
      return runtime.paths.coral.coordinator.infoFile;
    } catch (error: unknown) {
      if (!isFlavorNotSettledError(error)) {
        throw error;
      }
    }
  }

  const env = runtime?.env ?? defaultEnv();
  const envSnapshot = env.fullSnapshot?.() ?? process.env;
  const baseDir = env.homedir === undefined ? undefined : join(env.homedir(), '.coral');
  return coordinatorPaths(flavor, envSnapshot, baseDir === undefined ? undefined : { baseDir }).infoFile;
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
  const infoPath = discoveryFilePath(flavor, deps);
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
    const raw = deps.storage.readFileSync(discoveryFilePath(flavor, deps), 'utf-8');
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
    deps.storage.unlinkSync(discoveryFilePath(flavor, deps));
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
