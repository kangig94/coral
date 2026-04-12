import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { backendInfoPath } from './paths.js';
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
    (record.startedAt as number) > 0
  );
}

export function writeBackendInfo(pluginRoot: string, info: BackendInfo): void {
  const infoPath = backendInfoPath(pluginRoot);
  mkdirSync(dirname(infoPath), { recursive: true });

  const tmpPath = `${infoPath}.tmp`;
  const payload = JSON.stringify(info);
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return; // parent dir removed — not fatal
    throw error;
  }
  renameSync(tmpPath, infoPath);

  if (process.platform !== 'win32') {
    try {
      chmodSync(infoPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

export function readBackendInfo(pluginRoot: string): BackendInfo | null {
  try {
    const raw = readFileSync(backendInfoPath(pluginRoot), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    // Default host for legacy backend.json files written before host field was added
    if (!record.host) record.host = '127.0.0.1';
    // Legacy backend.json files predate flavor; default them to prod on read.
    if (!('flavor' in record)) record.flavor = 'prod';
    if (!isBackendInfo(parsed)) return null;
    return parsed;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function removeBackendInfoIfOwner(pluginRoot: string, instanceId: string): void {
  const info = readBackendInfo(pluginRoot);
  if (!info || info.instanceId !== instanceId) return;

  try {
    unlinkSync(backendInfoPath(pluginRoot));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}
