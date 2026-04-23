import { readFileSync } from 'node:fs';

import type { RuntimeStoragePort } from '../../runtime/ports.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { sessionEntrySchema, type SessionEntry } from '../entry.js';

type SessionEntryStorage = Pick<RuntimeStoragePort, 'readFileSync'>;

function defaultStorage(): SessionEntryStorage {
  return { readFileSync };
}

export function readSessionJson(
  sessionPath: string,
  storage?: SessionEntryStorage,
): unknown | null {
  try {
    const reader = storage ?? defaultStorage();
    return JSON.parse(reader.readFileSync(sessionPath, 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function isValidSessionEntry(value: unknown): value is SessionEntry {
  return sessionEntrySchema.safeParse(value).success;
}

export function readSessionEntry(
  sessionPath: string,
  storage?: SessionEntryStorage,
): SessionEntry | null {
  const entry = readSessionJson(sessionPath, storage);
  if (entry === null) return null;
  return isValidSessionEntry(entry) ? entry : null;
}
