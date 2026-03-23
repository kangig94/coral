import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import {
  invalidateKbCache,
  readIndexState,
  recordIndexSyncFailure,
  recordReindexSuccess,
  withKbMutationLock,
  writeKbIndex,
} from './detect.js';
import { deriveNoteIdentity, extractTitle, parseFrontmatter } from './frontmatter.js';
import { rebuildEnhancedIndex, type KbReindexNoteRecord } from './reindex-enhanced.js';
import type { KbContext, KbIndex } from './types.js';

const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/;
const TOP_LEVEL_TITLE = /^# .+(?:\r?\n){1,2}/;

type ReindexResult = {
  notes: number;
  principles: number;
  tags: number;
  duration_ms: number;
  mode: 'basic' | 'enhanced';
  warning?: string;
};

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

function extractPrincipleStatement(content: string): string {
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
    }])),
    principles: Object.fromEntries(principles),
  };
}

function basicLossWarning(): string {
  return 'Enhanced KB runtime is unavailable; rebuilt the basic index only.';
}

function enhancedFailureWarning(): string {
  return 'Enhanced KB reindex failed; rebuilt the basic index only. Run kb_reindex again to refresh the enhanced index.';
}

function concurrentSnapshotWarning(): string {
  return 'KB state changed during reindex; rebuilt the basic index only. Run kb_reindex again to refresh the enhanced index.';
}

export async function reindex(kb: KbContext): Promise<ReindexResult> {
  const startedAt = Date.now();
  const preCallState = readIndexState();

  return withKbMutationLock(async () => {
    const startSeq = readIndexState().mutationSeq;
    const notes = loadNotes(kb.kbRoot);
    const principles = loadPrinciples(kb.kbRoot);
    const uniqueTags = new Set(notes.flatMap((note) => note.tags));
    const index = buildKbIndex(notes, principles);

    writeKbIndex(index);
    invalidateKbCache();

    let mode: 'basic' | 'enhanced' = 'basic';
    let warning: string | undefined;

    if (kb.adapter !== null) {
      try {
        await rebuildEnhancedIndex(kb, notes);
        const state = recordReindexSuccess(startSeq);
        if (state.indexedSeq === startSeq && state.staleReason === undefined) {
          mode = 'enhanced';
        } else {
          warning = concurrentSnapshotWarning();
        }
      } catch (error: unknown) {
        recordIndexSyncFailure(`Enhanced KB reindex failed: ${errorMessage(error)}`);
        warning = enhancedFailureWarning();
      }
    } else if (preCallState.indexedSeq > 0) {
      warning = basicLossWarning();
    }

    return {
      notes: notes.length,
      principles: principles.length,
      tags: uniqueTags.size,
      duration_ms: Date.now() - startedAt,
      mode,
      ...(warning === undefined ? {} : { warning }),
    };
  });
}
