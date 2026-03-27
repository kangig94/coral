import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { backendInfoPath } from './paths.js';
import { isNoEntryError } from '../shared/mcp-utils.js';

export { backendInfoPath } from './paths.js';

export type BackendInfo = {
  pid: number;
  port: number;
  host: string;
  token: string;
  version: string;
  bundleHash: string;
  instanceId: string;
  namespace: string;
  startedAt: number;
};

function isBackendInfo(value: unknown): value is BackendInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.host === undefined) record.host = '127.0.0.1';
  return Number.isInteger(record.pid)
    && (record.pid as number) > 0
    && Number.isInteger(record.port)
    && (record.port as number) > 0
    && typeof record.host === 'string'
    && record.host.length > 0
    && typeof record.token === 'string'
    && record.token.length > 0
    && typeof record.version === 'string'
    && record.version.length > 0
    && typeof record.bundleHash === 'string'
    && record.bundleHash.length > 0
    && typeof record.instanceId === 'string'
    && record.instanceId.length > 0
    && typeof record.namespace === 'string'
    && record.namespace.length > 0
    && Number.isFinite(record.startedAt)
    && (record.startedAt as number) > 0;
}

export function writeBackendInfo(pluginRoot: string, info: BackendInfo): void {
  const infoPath = backendInfoPath(pluginRoot);
  mkdirSync(dirname(infoPath), { recursive: true });

  const tmpPath = `${infoPath}.tmp`;
  const payload = JSON.stringify(info);
  writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, infoPath);

  if (process.platform !== 'win32') {
    chmodSync(infoPath, 0o600);
  }
}

export function readBackendInfo(pluginRoot: string): BackendInfo | null {
  try {
    const raw = readFileSync(backendInfoPath(pluginRoot), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isBackendInfo(parsed) ? parsed : null;
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
