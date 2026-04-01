import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertMultiple } from '@orama/orama';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import { deriveNoteIdentity, extractBody, extractPrincipleStatement, parseSourceFrontmatter } from './frontmatter.js';
import { buildNoteIndexEntry, buildSourceIndexEntry } from './mutation-helpers.js';
import { loadKbNote } from './read.js';
import { assertSourceSlug, compareLocale } from './validation.js';
import { createOramaDb, toOramaDocument } from './orama-factory.js';
import type { KbRuntime } from './runtime.js';
import {
  noteEntryId,
  sourceEntryId,
  type KbIndex,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
  type ReindexResult,
} from './types.js';

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
    try {
      const { frontmatter, title, body } = loadKbNote(join(notesPath, entry));
      const identity = deriveNoteIdentity(entry);
      notes.push({
        note: identity.note,
        path: `notes/${entry}`,
        domain: identity.domain,
        title,
        body,
        ...frontmatter,
      });
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB note ${entry}: ${errorMessage(error)}`);
    }
  }

  return notes;
}

function loadSources(kb: KbRuntime): KbReindexSourceRecord[] {
  const sourcesPath = kb.sourcesDir();
  const sources: KbReindexSourceRecord[] = [];

  for (const entry of sortedMarkdownEntries(sourcesPath)) {
    try {
      const raw = readFileSync(join(sourcesPath, entry), 'utf-8');
      sources.push({
        slug: assertSourceSlug(entry.slice(0, -3), 'KB source name'),
        path: `sources/${entry}`,
        body: extractBody(raw),
        ...parseSourceFrontmatter(raw),
      });
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB source ${entry}: ${errorMessage(error)}`);
    }
  }

  return sources;
}

function loadPrinciples(kb: KbRuntime): Array<[string, string]> {
  const principlesPath = kb.principlesDir();
  const principles: Array<[string, string]> = [];

  for (const entry of sortedMarkdownEntries(principlesPath)) {
    try {
      const name = entry.slice(0, -3);
      const content = readFileSync(join(principlesPath, entry), 'utf-8');
      principles.push([name, extractPrincipleStatement(content)]);
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB principle ${entry}: ${errorMessage(error)}`);
    }
  }

  return principles;
}

function buildKbIndex(
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  principles: Array<[string, string]>,
): KbIndex {
  const entries: KbIndex['entries'] = {};

  for (const note of notes) {
    entries[noteEntryId(note.note)] = buildNoteIndexEntry({
      slug: note.note,
      title: note.title,
      tags: note.tags,
      principles: note.principles,
      source: note.source,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      related: note.related ?? [],
      ...(note.entrySeq === undefined ? {} : { entrySeq: note.entrySeq }),
    });
  }

  for (const source of sources) {
    entries[sourceEntryId(source.slug)] = buildSourceIndexEntry({
      slug: source.slug,
      title: source.title,
      type: source.type,
      tags: source.tags,
      ...(source.url === undefined ? {} : { url: source.url }),
      importedAt: source.importedAt,
      related: source.related ?? [],
      ...(source.entrySeq === undefined ? {} : { entrySeq: source.entrySeq }),
    });
  }

  return {
    entries,
    principles: Object.fromEntries(principles),
  };
}

function buildCounts(
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  principles: Array<[string, string]>,
): Pick<ReindexResult, 'notes' | 'sources' | 'principles' | 'tags'> {
  return {
    notes: notes.length,
    sources: sources.length,
    principles: principles.length,
    tags: new Set([...notes.flatMap((note) => note.tags), ...sources.flatMap((source) => source.tags)]).size,
  };
}

export class TextSnapshotRebuildError extends Error {
  readonly counts: Pick<ReindexResult, 'notes' | 'sources' | 'principles' | 'tags'>;

  constructor(message: string, counts: Pick<ReindexResult, 'notes' | 'sources' | 'principles' | 'tags'>) {
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
  sources: KbReindexSourceRecord[];
  principles: Array<[string, string]>;
  counts: Pick<ReindexResult, 'notes' | 'sources' | 'principles' | 'tags'>;
}> {
  const notes = loadNotes(kb);
  const sources = loadSources(kb);
  const principles = loadPrinciples(kb);
  const counts = buildCounts(notes, sources, principles);
  const index = buildKbIndex(notes, sources, principles);
  const { db, tokenizer } = await createOramaDb();

  await insertMultiple(db, [...notes.map(toOramaDocument), ...sources.map(toOramaDocument)]);
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
    sources,
    principles,
    counts,
  };
}
