import { errorMessage } from '../../../infra/error-format.js';
import { backendLog } from '../../../infra/backend-log.js';
import { readMalformedEntryRepair, type PendingRepair } from '../state/index.js';
import {
  deriveNoteIdentity,
  extractBody,
  extractPrincipleStatement,
  parseMembersFromBody,
  parseSummaryFromBody,
} from '../../corpus/frontmatter.js';
import { buildCommunityIndexEntry, buildNoteIndexEntry, buildSourceIndexEntry } from '../../corpus/index-records.js';
import type {
  CorpusMarkdownFileScan,
  CorpusScanView,
} from '../../corpus/repair/corpus-scan.js';
import { assertCommunitySlug, assertSourceSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import {
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  type CommunityFrontmatter,
  type KbIndex,
  type KbNoteFrontmatter,
  type KbReindexCommunityRecord,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
  type KbSourceFrontmatter,
  type ReindexResult,
} from '../../entry-types.js';

type LoadedArtifacts<T> = {
  entries: T[];
  pendingRepair: PendingRepair[];
};

export function loadNotes(scan: CorpusScanView, detectedAt: string): LoadedArtifacts<KbReindexNoteRecord> {
  const notes: KbReindexNoteRecord[] = [];
  const pendingRepair: PendingRepair[] = [];

  for (const file of filesOfKind(scan, 'note')) {
    const filename = `${file.slug}.md`;
    try {
      const frontmatter = requireTypedFrontmatter<KbNoteFrontmatter>(file);
      const title = requireTitle(file);
      const identity = deriveNoteIdentity(filename);
      notes.push({
        note: identity.note,
        path: `notes/${filename}`,
        domain: identity.domain,
        title,
        body: extractBody(file.content),
        ...frontmatter,
      });
    } catch (error: unknown) {
      const repair = readMalformedEntryRepair(file.path, 'note', file.slug, detectedAt);
      if (repair !== null) {
        pendingRepair.push(repair);
      }
      backendLog.warn(`Skipping malformed KB note ${filename}: ${errorMessage(error)}`);
    }
  }

  return {
    entries: notes,
    pendingRepair,
  };
}

export function loadSources(scan: CorpusScanView, detectedAt: string): LoadedArtifacts<KbReindexSourceRecord> {
  const sources: KbReindexSourceRecord[] = [];
  const pendingRepair: PendingRepair[] = [];

  for (const file of filesOfKind(scan, 'source')) {
    const filename = `${file.slug}.md`;
    try {
      const frontmatter = requireTypedFrontmatter<KbSourceFrontmatter>(file);
      sources.push({
        slug: assertSourceSlug(file.slug, 'KB source name'),
        path: `sources/${filename}`,
        body: extractBody(file.content),
        ...frontmatter,
      });
    } catch (error: unknown) {
      const repair = readMalformedEntryRepair(file.path, 'source', file.slug, detectedAt);
      if (repair !== null) {
        pendingRepair.push(repair);
      }
      backendLog.warn(`Skipping malformed KB source ${filename}: ${errorMessage(error)}`);
    }
  }

  return {
    entries: sources,
    pendingRepair,
  };
}

export function loadCommunities(scan: CorpusScanView): KbReindexCommunityRecord[] {
  const communities: KbReindexCommunityRecord[] = [];

  for (const file of filesOfKind(scan, 'community')) {
    const filename = `${file.slug}.md`;
    try {
      const frontmatter = requireTypedFrontmatter<CommunityFrontmatter>(file);
      const title = requireTitle(file);
      const body = extractBody(file.content);
      communities.push({
        slug: assertCommunitySlug(file.slug, 'KB community name'),
        path: `communities/${filename}`,
        ...frontmatter,
        title,
        body,
        level: frontmatter.level,
        members: parseMembersFromBody(body),
        ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
        ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
        summary: parseSummaryFromBody(body),
      });
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB community ${filename}: ${errorMessage(error)}`);
    }
  }

  return communities;
}

export function loadPrinciples(scan: CorpusScanView): Array<[string, string]> {
  const principles: Array<[string, string]> = [];

  for (const file of filesOfKind(scan, 'principle')) {
    try {
      principles.push([file.slug, extractPrincipleStatement(file.content)]);
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB principle ${file.slug}.md: ${errorMessage(error)}`);
    }
  }

  return principles;
}

function filesOfKind(scan: CorpusScanView, kind: CorpusMarkdownFileScan['kind']): CorpusMarkdownFileScan[] {
  return scan.markdownFiles.filter((file) => file.kind === kind);
}

function requireTypedFrontmatter<T>(file: CorpusMarkdownFileScan): T {
  if (file.frontmatter.typed !== null) {
    return file.frontmatter.typed as T;
  }
  if (file.frontmatter.typedError !== null) {
    throw file.frontmatter.typedError;
  }
  if (file.frontmatter.error !== null) {
    throw file.frontmatter.error;
  }
  throw new Error(`Frontmatter unavailable (status: ${file.frontmatter.status})`);
}

function requireTitle(file: CorpusMarkdownFileScan): string {
  if (file.titleError !== null) {
    throw file.titleError;
  }
  if (file.title === null) {
    throw new Error('Title unavailable');
  }
  return file.title;
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
