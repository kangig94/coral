import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertMultiple } from '@orama/orama';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import {
  deriveNoteIdentity,
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseCommunityFrontmatter,
  parseSourceFrontmatter,
} from './frontmatter.js';
import { buildCommunityIndexEntry, buildNoteIndexEntry, buildSourceIndexEntry } from './mutation-helpers.js';
import { stripMdExt } from './paths.js';
import { loadKbNote } from './read.js';
import { assertCommunitySlug, assertSourceSlug, compareLocale } from './validation.js';
import { createOramaDb, toOramaDocument } from './orama-factory.js';
import type { KbRuntime } from './runtime.js';
import {
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  type KbIndex,
  type KbReindexCommunityRecord,
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
        slug: assertSourceSlug(stripMdExt(entry), 'KB source name'),
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

function loadCommunityDocument(communityPath: string): Omit<KbReindexCommunityRecord, 'path' | 'slug'> {
  const raw = readFileSync(communityPath, 'utf-8');
  return {
    ...parseCommunityFrontmatter(raw),
    title: extractTitle(raw),
    body: extractBody(raw),
  };
}

export function loadCommunities(kb: KbRuntime): KbReindexCommunityRecord[] {
  const communitiesPath = kb.communitiesDir();
  const communities: KbReindexCommunityRecord[] = [];

  for (const entry of sortedMarkdownEntries(communitiesPath)) {
    try {
      communities.push({
        slug: assertCommunitySlug(stripMdExt(entry), 'KB community name'),
        path: `communities/${entry}`,
        ...loadCommunityDocument(join(communitiesPath, entry)),
      });
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB community ${entry}: ${errorMessage(error)}`);
    }
  }

  return communities;
}

function loadPrinciples(kb: KbRuntime): Array<[string, string]> {
  const principlesPath = kb.principlesDir();
  const principles: Array<[string, string]> = [];

  for (const entry of sortedMarkdownEntries(principlesPath)) {
    try {
      const name = stripMdExt(entry);
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
  communities: KbReindexCommunityRecord[],
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

  for (const community of communities) {
    entries[communityEntryId(community.slug)] = buildCommunityIndexEntry({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
      generatedBy: community.generatedBy,
      createdAt: community.createdAt,
      updatedAt: community.updatedAt,
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
  communities: KbReindexCommunityRecord[],
  principles: Array<[string, string]>,
): Pick<ReindexResult, 'notes' | 'sources' | 'communities' | 'principles' | 'tags'> {
  return {
    notes: notes.length,
    sources: sources.length,
    communities: communities.length,
    principles: principles.length,
    tags: new Set([
      ...notes.flatMap((note) => note.tags),
      ...sources.flatMap((source) => source.tags),
      ...communities.flatMap((community) => community.members),
    ]).size,
  };
}

export class TextSnapshotRebuildError extends Error {
  readonly counts: Pick<ReindexResult, 'notes' | 'sources' | 'communities' | 'principles' | 'tags'>;

  constructor(
    message: string,
    counts: Pick<ReindexResult, 'notes' | 'sources' | 'communities' | 'principles' | 'tags'>,
  ) {
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
  communities: KbReindexCommunityRecord[];
  principles: Array<[string, string]>;
  counts: Pick<ReindexResult, 'notes' | 'sources' | 'communities' | 'principles' | 'tags'>;
}> {
  const notes = loadNotes(kb);
  const sources = loadSources(kb);
  const communities = loadCommunities(kb);
  const principles = loadPrinciples(kb);
  const counts = buildCounts(notes, sources, communities, principles);
  const index = buildKbIndex(notes, sources, communities, principles);
  const { db, tokenizer } = await createOramaDb();

  await insertMultiple(db, [
    ...notes.map(toOramaDocument),
    ...sources.map(toOramaDocument),
    ...communities.map(toOramaDocument),
  ]);
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
  if (
    nextState.mutationSeq !== startSeq ||
    nextState.textIndexedSeq !== startSeq ||
    nextState.textStaleReason !== undefined
  ) {
    const reason = 'KB text index freshness changed during rebuild.';
    kb.invalidateTextSnapshot(reason);
    kb.invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts);
  }

  kb.installRebuiltArtifacts(index, { db, tokenizer });

  return {
    notes,
    sources,
    communities,
    principles,
    counts,
  };
}
