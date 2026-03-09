import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isNoEntryError } from '../shared/mcp-utils.js';

export const BACKEND_INFO_PATH = join(homedir(), '.claude', 'coral', 'backend.json');

export type BackendInfo = {
  pid: number;
  port: number;
  token: string;
  version: string;
  bundleHash: string;
  instanceId: string;
  startedAt: number;
};

function isBackendInfo(value: unknown): value is BackendInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.pid)
    && (record.pid as number) > 0
    && Number.isInteger(record.port)
    && (record.port as number) > 0
    && typeof record.token === 'string'
    && record.token.length > 0
    && typeof record.version === 'string'
    && record.version.length > 0
    && typeof record.bundleHash === 'string'
    && record.bundleHash.length > 0
    && typeof record.instanceId === 'string'
    && record.instanceId.length > 0
    && Number.isFinite(record.startedAt)
    && (record.startedAt as number) > 0;
}

export function writeBackendInfo(info: BackendInfo): void {
  mkdirSync(dirname(BACKEND_INFO_PATH), { recursive: true });

  const tmpPath = `${BACKEND_INFO_PATH}.tmp`;
  const payload = JSON.stringify(info);
  writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, BACKEND_INFO_PATH);

  if (process.platform !== 'win32') {
    chmodSync(BACKEND_INFO_PATH, 0o600);
  }
}

export function readBackendInfo(): BackendInfo | null {
  try {
    const raw = readFileSync(BACKEND_INFO_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isBackendInfo(parsed) ? parsed : null;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function removeBackendInfoIfOwner(instanceId: string): void {
  const info = readBackendInfo();
  if (!info || info.instanceId !== instanceId) return;

  try {
    unlinkSync(BACKEND_INFO_PATH);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}
