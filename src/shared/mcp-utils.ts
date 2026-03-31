import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type McpResult = { content: [{ type: 'text'; text: string }]; isError: boolean };

export function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Delete a file, ignoring ENOENT (already deleted). */
export function unlinkIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

/** Classify transient SSE/connection errors eligible for cursor-based retry. */
export function isTransientStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === 'terminated') return true;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ECONNABORTED';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const identPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Check whether a value is a valid token-safe owner identifier. */
export function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && identPattern.test(value);
}

/** Validate and return a token-safe owner identifier, or throw on invalid/blank values. */
export function assertOwnerId(value: unknown, label = 'owner'): string {
  if (!isOwnerId(value)) {
    throw new Error(
      `${label} must be a non-empty token-safe identifier (alphanumeric, '.', '_', '-'; must start with alphanumeric)`,
    );
  }
  return value;
}

export const providerIdentPattern = /^[a-z][a-z0-9-]*$/;

export function textResult(text: string, isError = false): McpResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

export function jsonResult(data: Record<string, unknown>): McpResult {
  return textResult(JSON.stringify(data, null, 2));
}

export function mcpError(data: Record<string, unknown>): McpResult {
  return textResult(JSON.stringify(data, null, 2), true);
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
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function collectCoralEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (!key.startsWith('CORAL_') || value === undefined) continue;
    env[key] = value;
  }
  return env;
}

export function readBundleHash(pluginRoot: string): string {
  try {
    const raw = readFileSync(join(pluginRoot, 'bridge', 'manifest.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.bundleHash === 'string') {
      return parsed.bundleHash;
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

/**
 * Attempt an exclusive-create write: creates parent directory, writes with O_EXCL,
 * and sets mode 0o600 on non-Windows. Returns true on success, false if file already exists.
 */
export const nowIsoString = (): string => new Date().toISOString();

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
