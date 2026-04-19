import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BuildFlavor } from '../runtime/flavor.js';
import type { RuntimeEnvPort, RuntimeStoragePort } from '../runtime/ports.js';
import {
  backendInfoPath as legacyBackendInfoPath,
  backendLockPath as legacyBackendLockPath,
} from '../infra/paths.js';
import { isNoEntryError } from '../shared/utils.js';
import { readBuildFlavor } from '../shared/utils.js';
import { coordinatorPaths } from './paths.js';

export interface CoordinatorDiscoveryRecord {
  pid: number;
  port: number;
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
  'chmodSync' | 'mkdirSync' | 'readFileSync' | 'renameSync' | 'unlinkSync' | 'writeFileSync'
>;
type DiscoveryEnv = Pick<RuntimeEnvPort, 'platform'>;
type DiscoveryRuntime = {
  storage: DiscoveryStorage;
  env?: DiscoveryEnv;
};

const DEFAULT_DISCOVERY_HOST = '127.0.0.1';

function normalizeDiscoveryRecord(value: unknown): CoordinatorDiscoveryRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const pid = Number.isInteger(record.pid) && (record.pid as number) > 0 ? (record.pid as number) : null;
  const port = Number.isInteger(record.port) && (record.port as number) > 0 ? (record.port as number) : null;
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

  return {
    pid,
    port,
    bundleHash,
    flavor,
    namespace,
    startedAt,
    token,
    ...(host !== undefined ? { host } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(processStartedAt !== undefined ? { processStartedAt } : {}),
  };
}

let linuxBootTimeSecondsCache: number | null | undefined;
let linuxClockTicksPerSecondCache: number | null | undefined;

function parseLinuxBootTimeSeconds(): number | null {
  if (linuxBootTimeSecondsCache !== undefined) {
    return linuxBootTimeSecondsCache;
  }

  try {
    const stat = readFileSync('/proc/stat', 'utf-8');
    const line = stat
      .split('\n')
      .find((entry) => entry.startsWith('btime '))
      ?.trim();
    if (!line) {
      linuxBootTimeSecondsCache = null;
      return linuxBootTimeSecondsCache;
    }

    const parsed = Number.parseInt(line.slice('btime '.length), 10);
    linuxBootTimeSecondsCache = Number.isFinite(parsed) ? parsed : null;
    return linuxBootTimeSecondsCache;
  } catch {
    linuxBootTimeSecondsCache = null;
    return linuxBootTimeSecondsCache;
  }
}

function parseLinuxClockTicksPerSecond(): number | null {
  if (linuxClockTicksPerSecondCache !== undefined) {
    return linuxClockTicksPerSecondCache;
  }

  try {
    const raw = execFileSync('getconf', ['CLK_TCK'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = Number.parseInt(raw, 10);
    linuxClockTicksPerSecondCache = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    return linuxClockTicksPerSecondCache;
  } catch {
    linuxClockTicksPerSecondCache = null;
    return linuxClockTicksPerSecondCache;
  }
}

function probeLinuxProcessStartedAtSeconds(pid: number): number | null {
  const bootTimeSeconds = parseLinuxBootTimeSeconds();
  const clockTicksPerSecond = parseLinuxClockTicksPerSecond();
  if (bootTimeSeconds === null || clockTicksPerSecond === null) {
    return null;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) {
      return null;
    }

    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = Number.parseInt(fields[19] ?? '', 10);
    if (!Number.isFinite(startTicks) || startTicks < 0) {
      return null;
    }

    return Math.floor(bootTimeSeconds + startTicks / clockTicksPerSecond);
  } catch {
    return null;
  }
}

function probeMacProcessStartedAtSeconds(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!raw) {
      return null;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  } catch {
    return null;
  }
}

function probeWindowsProcessStartedAtSeconds(pid: number): number | null {
  try {
    const raw = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = raw.match(/CreationDate=(\d{14})\./);
    if (!match) {
      return null;
    }

    const value = match[1];
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(4, 6), 10) - 1;
    const day = Number.parseInt(value.slice(6, 8), 10);
    const hour = Number.parseInt(value.slice(8, 10), 10);
    const minute = Number.parseInt(value.slice(10, 12), 10);
    const second = Number.parseInt(value.slice(12, 14), 10);
    return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000);
  } catch {
    return null;
  }
}

export function probeProcessStartedAtSeconds(pid: number, platform = process.platform): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (platform === 'linux') {
    return probeLinuxProcessStartedAtSeconds(pid);
  }
  if (platform === 'darwin') {
    return probeMacProcessStartedAtSeconds(pid);
  }
  if (platform === 'win32') {
    return probeWindowsProcessStartedAtSeconds(pid);
  }
  return null;
}

function defaultStorage(): DiscoveryStorage {
  return { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync };
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

function legacyBackendFilePath(
  pluginRoot: string,
  resolver: (pluginRoot: string) => string,
): string | null {
  try {
    return resolver(pluginRoot);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

function writeCompatFile(
  filePath: string | null,
  payload: string,
  runtime: Required<DiscoveryRuntime>,
): void {
  if (!filePath) {
    return;
  }

  runtime.storage.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;

  try {
    runtime.storage.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }

  runtime.storage.renameSync(tmpPath, filePath);
  if (runtime.env.platform() !== 'win32') {
    try {
      runtime.storage.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}

function removeCompatFileIfOwner(
  filePath: string | null,
  owner: string,
  runtime: Required<DiscoveryRuntime>,
): void {
  if (!filePath) {
    return;
  }

  try {
    const raw = runtime.storage.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const instanceId = (parsed as Record<string, unknown>).instanceId;
    if (instanceId !== owner) {
      return;
    }

    runtime.storage.unlinkSync(filePath);
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return;
    }
    throw error;
  }
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
  const tmpPath = `${infoPath}.tmp`;

  try {
    deps.storage.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }

  deps.storage.renameSync(tmpPath, infoPath);
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
  token: string,
  runtime?: DiscoveryRuntime,
): void {
  const deps = resolveDiscoveryRuntime(runtime);
  const record = readDiscoveryRecord(flavor, deps);
  if (!record || record.token !== token) {
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
  const payload = JSON.stringify(info);
  const legacyLockPath = legacyBackendFilePath(pluginRoot, legacyBackendLockPath);
  if (legacyLockPath !== null) {
    deps.storage.mkdirSync(dirname(legacyLockPath), { recursive: true });
  }

  writeDiscoveryRecord(flavorForPluginRoot(pluginRoot), info, deps);
  writeCompatFile(legacyBackendFilePath(pluginRoot, legacyBackendInfoPath), payload, deps);
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
  const deps = resolveDiscoveryRuntime(runtime);
  const flavor = flavorForPluginRoot(pluginRoot);
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

  removeDiscoveryRecordIfOwner(flavor, record.token, deps);
  removeCompatFileIfOwner(legacyBackendFilePath(pluginRoot, legacyBackendInfoPath), owner, deps);
}
