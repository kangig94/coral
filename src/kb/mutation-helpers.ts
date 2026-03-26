import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage } from '../shared/mcp-utils.js';
import type { KbIndexState } from './runtime.js';
import type { KbIndex } from './types.js';

type NoteIndexEntrySource = {
  title: string;
  tags: readonly string[];
  principles: readonly string[];
  source: readonly string[];
  createdAt: string;
  updatedAt: string;
  mutationSeqAtPromote?: number;
};

/** Build a deep-copied KbIndex note record from any source that carries the same fields. */
export function buildNoteIndexEntry(meta: NoteIndexEntrySource): KbIndex['notes'][string] {
  return {
    title: meta.title,
    tags: [...meta.tags],
    principles: [...meta.principles],
    source: [...meta.source],
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.mutationSeqAtPromote === undefined ? {} : { mutationSeqAtPromote: meta.mutationSeqAtPromote }),
  };
}

export function writeFileAtomic(filePath: string, payload: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;

  try {
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function cloneKbIndex(index: KbIndex | null): KbIndex {
  if (index === null) {
    return {
      notes: {},
      principles: {},
    };
  }

  return {
    notes: Object.fromEntries(
      Object.entries(index.notes).map(([note, meta]) => [note, buildNoteIndexEntry(meta)]),
    ),
    principles: { ...index.principles },
  };
}

export function markTextIndexStale(
  invalidate: (reason: string) => KbIndexState,
  reason: string,
): void {
  try {
    invalidate(reason);
  } catch (error: unknown) {
    process.stderr.write(`markTextIndexStale: ${errorMessage(error)}\n`);
  }
}
