import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import { readMalformedEntryRepair, type PendingRepair } from './state.js';
import {
  deriveNoteIdentity,
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseCommunityFrontmatter,
  parseMembersFromBody,
  parseSourceFrontmatter,
  parseSummaryFromBody,
} from '../corpus/frontmatter.js';
import { buildCommunityIndexEntry, buildNoteIndexEntry, buildSourceIndexEntry } from '../corpus/index-records.js';
import { sortedMarkdownEntries } from '../corpus/markdown-entries.js';
import { stripMdExt } from '../paths.js';
import { loadKbNote } from '../read.js';
import { assertCommunitySlug, assertSourceSlug } from '../validation.js';
import type { KbRuntime } from '../contracts.js';
import {
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  type KbIndex,
  type KbReindexCommunityRecord,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
  type ReindexResult,
} from '../entry-types.js';

type LoadedArtifacts<T> = {
  entries: T[];
  pendingRepair: PendingRepair[];
};

export function loadNotes(kb: KbRuntime, detectedAt: string): LoadedArtifacts<KbReindexNoteRecord> {
  const notesPath = kb.notesDir();
  const notes: KbReindexNoteRecord[] = [];
  const pendingRepair: PendingRepair[] = [];

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
      const repair = readMalformedEntryRepair(join(notesPath, entry), 'note', stripMdExt(entry), detectedAt);
      if (repair !== null) {
        pendingRepair.push(repair);
      }
      backendLog.warn(`Skipping malformed KB note ${entry}: ${errorMessage(error)}`);
    }
  }

  return {
    entries: notes,
    pendingRepair,
  };
}

export function loadSources(kb: KbRuntime, detectedAt: string): LoadedArtifacts<KbReindexSourceRecord> {
  const sourcesPath = kb.sourcesDir();
  const sources: KbReindexSourceRecord[] = [];
  const pendingRepair: PendingRepair[] = [];

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
      const repair = readMalformedEntryRepair(join(sourcesPath, entry), 'source', stripMdExt(entry), detectedAt);
      if (repair !== null) {
        pendingRepair.push(repair);
      }
      backendLog.warn(`Skipping malformed KB source ${entry}: ${errorMessage(error)}`);
    }
  }

  return {
    entries: sources,
    pendingRepair,
  };
}

function loadCommunityDocument(communityPath: string): Omit<KbReindexCommunityRecord, 'path' | 'slug'> {
  const raw = readFileSync(communityPath, 'utf-8');
  const frontmatter = parseCommunityFrontmatter(raw);
  const body = extractBody(raw);
  return {
    ...frontmatter,
    title: extractTitle(raw),
    body,
    level: frontmatter.level,
    members: parseMembersFromBody(body),
    ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
    ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
    summary: parseSummaryFromBody(body),
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

export function loadPrinciples(kb: KbRuntime): Array<[string, string]> {
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

export function buildKbIndex(
  kb: KbRuntime,
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  communities: KbReindexCommunityRecord[],
  principles: Array<[string, string]>,
): KbIndex {
  const entries: KbIndex['entries'] = {};
  const entityGraph = kb.readEntityGraph();

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
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
      createdAt: community.createdAt,
      updatedAt: community.updatedAt,
    });
  }

  return {
    entries,
    principles: Object.fromEntries(principles),
    entityMeta: entityGraph?.entityMeta ?? {},
    relationships: entityGraph?.relationships ?? [],
  };
}

export function buildCounts(
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  communities: KbReindexCommunityRecord[],
  principles: Array<[string, string]>,
  index: KbIndex,
): Pick<
  ReindexResult,
  'notes' | 'sources' | 'communities' | 'principles' | 'tags' | 'entities' | 'relationships' | 'entityCoverage'
> {
  const entityMeta = index.entityMeta;
  const uniqueTags = new Set([
    ...notes.flatMap((note) => note.tags),
    ...sources.flatMap((source) => source.tags),
    ...communities.flatMap((community) => community.members),
  ]);
  const entityNames = Object.keys(entityMeta);
  const coveredTags = [...uniqueTags].filter((tag) => Object.prototype.hasOwnProperty.call(entityMeta, tag)).length;
  return {
    notes: notes.length,
    sources: sources.length,
    communities: communities.length,
    principles: principles.length,
    tags: uniqueTags.size,
    entities: entityNames.length,
    relationships: index.relationships?.length ?? 0,
    entityCoverage: uniqueTags.size === 0 ? 1 : coveredTags / uniqueTags.size,
  };
}
