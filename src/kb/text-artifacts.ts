import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertMultiple } from '@orama/orama';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import { buildNoteIndexEntry } from './mutation-helpers.js';
import { compareLocale } from './validation.js';
import {
  extractBody,
  deriveNoteIdentity,
  extractPrincipleStatement,
  extractTitle,
  parseFrontmatter,
} from './frontmatter.js';
import { createOramaDb, toOramaDocument } from './orama-factory.js';
import type { KbRuntime } from './runtime.js';
import type { KbIndex, KbReindexNoteRecord, ReindexResult } from './types.js';

export function sortedMarkdownEntries(dirPath: string): string[] {
  try {
    return readdirSync(dirPath)
      .filter((entry) => entry.endsWith('.md'))
      .sort(compareLocale);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}

function loadNotes(kb: KbRuntime): KbReindexNoteRecord[] {
  const notesPath = kb.notesDir();
  const notes: KbReindexNoteRecord[] = [];

  for (const entry of sortedMarkdownEntries(notesPath)) {
    const content = readFileSync(join(notesPath, entry), 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const identity = deriveNoteIdentity(entry);
    notes.push({
      note: identity.note,
      path: `notes/${entry}`,
      domain: identity.domain,
      title: extractTitle(content),
      body: extractBody(content),
      tags: [...frontmatter.tags],
      principles: [...frontmatter.principles],
      source: [...frontmatter.source],
      createdAt: frontmatter.createdAt,
      updatedAt: frontmatter.updatedAt,
      ...(frontmatter.mutationSeqAtPromote === undefined
        ? {}
        : { mutationSeqAtPromote: frontmatter.mutationSeqAtPromote }),
    });
  }

  return notes;
}

function loadPrinciples(kb: KbRuntime): Array<[string, string]> {
  const principlesPath = kb.principlesDir();
  const principles: Array<[string, string]> = [];

  for (const entry of sortedMarkdownEntries(principlesPath)) {
    const name = entry.slice(0, -3);
    const content = readFileSync(join(principlesPath, entry), 'utf-8');
    principles.push([name, extractPrincipleStatement(content)]);
  }

  return principles;
}

function buildKbIndex(notes: KbReindexNoteRecord[], principles: Array<[string, string]>): KbIndex {
  return {
    notes: Object.fromEntries(notes.map((note) => [note.note, buildNoteIndexEntry(note)])),
    principles: Object.fromEntries(principles),
  };
}

function buildCounts(
  notes: KbReindexNoteRecord[],
  principles: Array<[string, string]>,
): Pick<ReindexResult, 'notes' | 'principles' | 'tags'> {
  return {
    notes: notes.length,
    principles: principles.length,
    tags: new Set(notes.flatMap((note) => note.tags)).size,
  };
}

export class TextSnapshotRebuildError extends Error {
  readonly counts: Pick<ReindexResult, 'notes' | 'principles' | 'tags'>;

  constructor(message: string, counts: Pick<ReindexResult, 'notes' | 'principles' | 'tags'>) {
    super(message);
    this.name = 'TextSnapshotRebuildError';
    this.counts = counts;
  }
}

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 */
export async function rebuildTextArtifacts(
  kb: KbRuntime,
  startSeq: number,
): Promise<{
  notes: KbReindexNoteRecord[];
  principles: Array<[string, string]>;
  counts: Pick<ReindexResult, 'notes' | 'principles' | 'tags'>;
}> {
  const notes = loadNotes(kb);
  const principles = loadPrinciples(kb);
  const counts = buildCounts(notes, principles);
  const index = buildKbIndex(notes, principles);
  const { db, tokenizer } = await createOramaDb();

  await insertMultiple(db, notes.map(toOramaDocument));
  kb.persistIndexToDisk(index);

  try {
    kb.persistOramaSnapshot(db);
  } catch (error: unknown) {
    const reason = `KB text index rebuild failed: ${errorMessage(error)}`;
    kb.invalidateTextSnapshot(reason);
    kb.invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts);
  }

  const nextState = kb.recordReindexSuccess(startSeq);
  if (nextState.mutationSeq !== startSeq || nextState.indexedSeq !== startSeq || nextState.staleReason !== undefined) {
    const reason = 'KB text index freshness changed during rebuild.';
    kb.invalidateTextSnapshot(reason);
    kb.invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts);
  }

  kb.installRebuiltArtifacts(index, { db, tokenizer });

  return {
    notes,
    principles,
    counts,
  };
}
