import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type McpResult = { content: [{ type: 'text'; text: string }]; isError: boolean };

export function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const identPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const providerIdentPattern = /^[a-z][a-z0-9-]*$/;

export function textResult(text: string, isError = false): McpResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

export function jsonResult(data: Record<string, unknown>): McpResult {
  return textResult(JSON.stringify(data, null, 2));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

type ResultLike<T extends Record<string, unknown>> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail?: Record<string, unknown> };

export function resultToMcp<T extends Record<string, unknown>>(result: ResultLike<T>): McpResult {
  if (result.ok) return jsonResult(result.value);
  return jsonResult({ error: result.error, ...(result.detail ?? {}) });
}

/**
 * Attempt an exclusive-create write: creates parent directory, writes with O_EXCL,
 * and sets mode 0o600 on non-Windows. Returns true on success, false if file already exists.
 */
export function tryExclusiveWrite(filePath: string, payload: string): boolean {
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(filePath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
  return true;
}
