import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertMultiple } from '@orama/orama';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import {
  installRebuiltKbArtifacts,
  invalidateKbCache,
  invalidateTextSnapshot,
  persistKbIndex,
  persistOramaSnapshot,
  readIndexState,
  recordReindexSuccess,
  withKbMutationLock,
} from './detect.js';
import { deriveNoteIdentity, extractTitle, parseFrontmatter } from './frontmatter.js';
import { createOramaDb, toOramaDocument } from './orama-factory.js';
import { rebuildEnhancedIndex } from './reindex-enhanced.js';
import type { KbContext, KbIndex, KbReindexNoteRecord, ReindexResult } from './types.js';

const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/;
const TOP_LEVEL_TITLE = /^# .+(?:\r?\n){1,2}/;

function sortedMarkdownEntries(dirPath: string): string[] {
  try {
    return readdirSync(dirPath)
      .filter((entry) => entry.endsWith('.md'))
      .sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}

function extractBody(content: string): string {
  return content
    .replace(FRONTMATTER_BLOCK, '')
    .replace(TOP_LEVEL_TITLE, '')
    .trim();
}

export function extractPrincipleStatement(content: string): string {
  const withoutFrontmatter = content.replace(FRONTMATTER_BLOCK, '').trim();
  if (!withoutFrontmatter) {
    throw new Error('KB principle is missing a statement');
  }
  return withoutFrontmatter.replace(/\s+/g, ' ');
}

function loadNotes(kbRoot: string): KbReindexNoteRecord[] {
  const notesPath = join(kbRoot, 'notes');
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

function loadPrinciples(kbRoot: string): Array<[string, string]> {
  const principlesPath = join(kbRoot, 'principles');
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
    notes: Object.fromEntries(notes.map((note) => [note.note, {
      title: note.title,
      tags: [...note.tags],
      principles: [...note.principles],
      source: [...note.source],
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      ...(note.mutationSeqAtPromote === undefined ? {} : { mutationSeqAtPromote: note.mutationSeqAtPromote }),
    }])),
    principles: Object.fromEntries(principles),
  };
}

function buildCounts(notes: KbReindexNoteRecord[], principles: Array<[string, string]>): Pick<ReindexResult, 'notes' | 'principles' | 'tags'> {
  return {
    notes: notes.length,
    principles: principles.length,
    tags: new Set(notes.flatMap((note) => note.tags)).size,
  };
}

function hybridWarning(error: unknown): string {
  return `KB vector tables were not rebuilt: ${errorMessage(error)}. Text search remains available.`;
}

class TextSnapshotRebuildError extends Error {
  readonly counts: Pick<ReindexResult, 'notes' | 'principles' | 'tags'>;

  constructor(message: string, counts: Pick<ReindexResult, 'notes' | 'principles' | 'tags'>) {
    super(message);
    this.name = 'TextSnapshotRebuildError';
    this.counts = counts;
  }
}

/**
 * @precondition Caller already holds `withKbMutationLock()`.
 */
export async function rebuildMetadataAndOrama(
  kb: KbContext,
  startSeq: number,
): Promise<{
  notes: KbReindexNoteRecord[];
  principles: Array<[string, string]>;
  counts: Pick<ReindexResult, 'notes' | 'principles' | 'tags'>;
}> {
  const notes = loadNotes(kb.kbRoot);
  const principles = loadPrinciples(kb.kbRoot);
  const counts = buildCounts(notes, principles);
  const index = buildKbIndex(notes, principles);
  const { db, tokenizer } = await createOramaDb();

  await insertMultiple(db, notes.map(toOramaDocument));
  persistKbIndex(index);

  try {
    persistOramaSnapshot(db);
  } catch (error: unknown) {
    const reason = `KB text index rebuild failed: ${errorMessage(error)}`;
    invalidateTextSnapshot(reason);
    invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts);
  }

  const nextState = recordReindexSuccess(startSeq);
  if (nextState.mutationSeq !== startSeq || nextState.indexedSeq !== startSeq || nextState.staleReason !== undefined) {
    const reason = 'KB text index freshness changed during rebuild.';
    invalidateTextSnapshot(reason);
    invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts);
  }

  installRebuiltKbArtifacts(index, { db, tokenizer });

  return {
    notes,
    principles,
    counts,
  };
}

export async function reindex(kb: KbContext): Promise<ReindexResult> {
  const startedAt = Date.now();

  return withKbMutationLock(async () => {
    const startSeq = readIndexState().mutationSeq;
    let rebuildResult: Awaited<ReturnType<typeof rebuildMetadataAndOrama>>;

    try {
      rebuildResult = await rebuildMetadataAndOrama(kb, startSeq);
    } catch (error: unknown) {
      if (error instanceof TextSnapshotRebuildError) {
        return {
          ...error.counts,
          duration_ms: Date.now() - startedAt,
          mode: 'text',
          warning: error.message,
        };
      }

      throw error;
    }

    let warning: string | undefined;

    if (kb.adapter !== null) {
      try {
        await rebuildEnhancedIndex(kb, rebuildResult.notes);
      } catch (error: unknown) {
        warning = hybridWarning(error);
      }
    }

    return {
      ...rebuildResult.counts,
      duration_ms: Date.now() - startedAt,
      mode: 'text',
      ...(warning === undefined ? {} : { warning }),
    };
  });
}
