import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeProcessPort, RuntimeStoragePort, RuntimeTimePort } from './runtime-ports.js';
import { identPattern } from './identifiers.js';

export function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Delete a file, ignoring ENOENT (already deleted). */
export function unlinkIfExists(filePath: string, storage?: Pick<RuntimeStoragePort, 'unlinkSync'>): void {
  try {
    if (storage) {
      storage.unlinkSync(filePath);
    } else {
      unlinkSync(filePath);
    }
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

/** HTTP error for transient server failures (502/503/504) eligible for retry. */
export class TransientHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TransientHttpError';
    this.status = status;
  }

  static isTransientStatus(status: number): boolean {
    return status === 502 || status === 503 || status === 504;
  }
}

export class BackendUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUnreachableError';
  }
}

/** Classify transient SSE/connection errors eligible for cursor-based retry. */
export function isTransientStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === 'terminated') return true;
  if (error instanceof TransientHttpError) return true;
  if (error instanceof BackendUnreachableError) return true;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ECONNABORTED';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function buildJsonRpcError(code: number, message: string, data?: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  return data === undefined ? { code, message } : { code, message, data };
}

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

export { identPattern, providerIdentPattern, AGENT_IDENT_RE } from './identifiers.js';

/** Parse an optional non-empty string from an unknown value. */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isProcessAlive(pid: number, runtimeProcess: Pick<RuntimeProcessPort, 'isAlive'>): boolean {
  return runtimeProcess.isAlive(pid);
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

export function readBuildFlavor(pluginRoot: string): 'prod' | 'dev' {
  try {
    const raw = readFileSync(join(pluginRoot, 'bridge', 'manifest.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed.flavor === 'dev') return 'dev';
  } catch {
    /* fall through */
  }
  return 'prod';
}

export function nowIsoString(timeOrEpoch?: Pick<RuntimeTimePort, 'now'> | number): string {
  const epochMs =
    typeof timeOrEpoch === 'number' ? timeOrEpoch : timeOrEpoch !== undefined ? timeOrEpoch.now() : Date.now();
  return new Date(epochMs).toISOString();
}

/** Race a promise against a timeout. Returns true if the promise settles first, false on timeout. */
export function raceTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  time?: Pick<RuntimeTimePort, 'setTimeout' | 'clearTimeout'>,
): Promise<boolean> {
  const timers = time ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout> | null) => {
      if (handle) clearTimeout(handle);
    },
  };

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      () => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
