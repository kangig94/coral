import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { backendInfoPath } from './paths.js';
import type { RuntimeEnvPort, RuntimePathsPort, RuntimeStoragePort } from '../runtime/ports.js';
import { isNoEntryError } from '../shared/utils.js';

export { backendInfoPath } from './paths.js';

export type BackendInfo = {
  pid: number;
  port: number;
  host: string;
  token: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  instanceId: string;
  namespace: string;
  startedAt: number;
  processStartedAt?: number;
};

function isBackendInfo(value: unknown): value is BackendInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    Number.isInteger(record.port) &&
    (record.port as number) > 0 &&
    (record.host === undefined || (typeof record.host === 'string' && record.host.length > 0)) &&
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    typeof record.version === 'string' &&
    record.version.length > 0 &&
    typeof record.bundleHash === 'string' &&
    record.bundleHash.length > 0 &&
    (record.flavor === 'prod' || record.flavor === 'dev') &&
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    typeof record.namespace === 'string' &&
    record.namespace.length > 0 &&
    Number.isFinite(record.startedAt) &&
    (record.startedAt as number) > 0 &&
    (record.processStartedAt === undefined ||
      (Number.isInteger(record.processStartedAt) && (record.processStartedAt as number) > 0))
  );
}

let linuxBootTimeSecondsCache: number | null | undefined;
let linuxClockTicksPerSecondCache: number | null | undefined;

function parseLinuxBootTimeSeconds(): number | null {
  if (linuxBootTimeSecondsCache !== undefined) return linuxBootTimeSecondsCache;

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
  if (linuxClockTicksPerSecondCache !== undefined) return linuxClockTicksPerSecondCache;

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
  if (bootTimeSeconds === null || clockTicksPerSecond === null) return null;

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return null;

    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = Number.parseInt(fields[19] ?? '', 10);
    if (!Number.isFinite(startTicks) || startTicks < 0) return null;

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
    if (!raw) return null;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.floor(parsed / 1000);
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
    if (!match) return null;
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
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (platform === 'linux') return probeLinuxProcessStartedAtSeconds(pid);
  if (platform === 'darwin') return probeMacProcessStartedAtSeconds(pid);
  if (platform === 'win32') return probeWindowsProcessStartedAtSeconds(pid);
  return null;
}

type BackendInfoStorage = Pick<
  RuntimeStoragePort,
  'chmodSync' | 'mkdirSync' | 'readFileSync' | 'renameSync' | 'unlinkSync' | 'writeFileSync'
>;
type BackendInfoPaths = Pick<RuntimePathsPort, 'backendInfoPath'>;
type BackendInfoEnv = Pick<RuntimeEnvPort, 'platform'>;
type BackendInfoRuntime = {
  storage: BackendInfoStorage;
  paths: BackendInfoPaths;
  env?: BackendInfoEnv;
};
function resolveInfoPath(pluginRoot: string, runtime?: BackendInfoRuntime): string {
  return runtime?.paths.backendInfoPath(pluginRoot) ?? backendInfoPath(pluginRoot);
}

function defaultStorage(): BackendInfoStorage {
  return { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync };
}

function defaultEnv(): BackendInfoEnv {
  return { platform: () => process.platform };
}

function resolveBackendInfoRuntime(runtime?: BackendInfoRuntime): Required<BackendInfoRuntime> {
  return {
    storage: runtime?.storage ?? defaultStorage(),
    paths: runtime?.paths ?? { backendInfoPath },
    env: runtime?.env ?? defaultEnv(),
  };
}

export function writeBackendInfo(pluginRoot: string, info: BackendInfo, runtime?: BackendInfoRuntime): void {
  const deps = resolveBackendInfoRuntime(runtime);
  const infoPath = resolveInfoPath(pluginRoot, deps);
  const payload = JSON.stringify({
    ...info,
    processStartedAt: info.processStartedAt ?? probeProcessStartedAtSeconds(info.pid, deps.env.platform() as NodeJS.Platform) ?? undefined,
  });
  deps.storage.mkdirSync(dirname(infoPath), { recursive: true });

  const tmpPath = `${infoPath}.tmp`;
  try {
    deps.storage.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return; // parent dir removed — not fatal
    throw error;
  }
  deps.storage.renameSync(tmpPath, infoPath);

  if (deps.env.platform() !== 'win32') {
    try {
      deps.storage.chmodSync(infoPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

export function readBackendInfo(pluginRoot: string, runtime?: BackendInfoRuntime): BackendInfo | null {
  const deps = resolveBackendInfoRuntime(runtime);
  try {
    const raw = deps.storage.readFileSync(resolveInfoPath(pluginRoot, deps), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    // Default host for legacy backend.json files written before host field was added
    record.host ??= '127.0.0.1';
    // Legacy backend.json files predate flavor; default them to prod on read.
    if (!('flavor' in record)) record.flavor = 'prod';
    if (!isBackendInfo(parsed)) return null;
    return parsed;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function removeBackendInfoIfOwner(pluginRoot: string, instanceId: string, runtime?: BackendInfoRuntime): void {
  const deps = resolveBackendInfoRuntime(runtime);
  const info = readBackendInfo(pluginRoot, deps);
  if (!info || info.instanceId !== instanceId) return;

  try {
    const infoPath = resolveInfoPath(pluginRoot, deps);
    deps.storage.unlinkSync(infoPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}
