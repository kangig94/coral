import { errorMessage } from '../../../infra/error-format.js';
import { backendLog } from '../../../infra/backend-log.js';
import {
  deriveNoteIdentity,
  extractBody,
  extractPrincipleStatement,
  parseMembersFromBody,
  parseSummaryFromBody,
} from '../frontmatter.js';
import { buildCommunityIndexEntry, buildNoteIndexEntry, buildSourceIndexEntry } from '../index-records.js';
import { assertCommunitySlug, assertSourceSlug } from '../../validation.js';
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
import { fileSyntaxDetector } from './incidents/file-syntax.js';
import { frontmatterShapeDetector } from './incidents/frontmatter.js';
import { identitySequenceDetector } from './incidents/identity.js';
import { referenceIntegrityDetector } from './incidents/references.js';
import type { CorpusMarkdownFileScan, CorpusScanView } from './scan.js';
import type { DetectedIncident, Detector } from './incidents/catalog.js';

const ALL_DETECTORS: readonly Detector[] = [
  fileSyntaxDetector,
  frontmatterShapeDetector,
  identitySequenceDetector,
  referenceIntegrityDetector,
];

/**
 * Aggregates detected incidents across every typed detector. Pure projection over
 * `CorpusScanView`; does not touch storage. Callers feed the result to
 * `applyDetectedIncidentFixesLocked` (under the mutation lock).
 */
export function projectIncidents(scan: CorpusScanView): DetectedIncident[] {
  return ALL_DETECTORS.flatMap((detector) => detector.detect(scan));
}

export function loadNotes(scan: CorpusScanView): KbReindexNoteRecord[] {
  const notes: KbReindexNoteRecord[] = [];

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
      backendLog.warn(`Skipping malformed KB note ${filename}: ${errorMessage(error)}`);
    }
  }

  return notes;
}

export function loadSources(scan: CorpusScanView): KbReindexSourceRecord[] {
  const sources: KbReindexSourceRecord[] = [];

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
      backendLog.warn(`Skipping malformed KB source ${filename}: ${errorMessage(error)}`);
    }
  }

  return sources;
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
        members: parseMembersFromBody(body),
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

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function requireTypedFrontmatter<T>(file: CorpusMarkdownFileScan): T {
  if (file.frontmatter.typed !== null) {
    return file.frontmatter.typed as T;
  }
  if (file.frontmatter.typedError !== null) {
    throw asError(file.frontmatter.typedError, 'Frontmatter typed-error');
  }
  if (file.frontmatter.error !== null) {
    throw asError(file.frontmatter.error, 'Frontmatter parse error');
  }
  throw new Error(`Frontmatter unavailable (status: ${file.frontmatter.status})`);
}

function requireTitle(file: CorpusMarkdownFileScan): string {
  if (file.titleError !== null) {
    throw asError(file.titleError, 'Title error');
  }
  if (file.title === null) {
    throw new Error('Title unavailable');
  }
  return file.title;
}

export function buildKbIndex(
  scan: CorpusScanView,
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  communities: KbReindexCommunityRecord[],
  principles: Array<[string, string]>,
): KbIndex {
  const entries: KbIndex['entries'] = {};
  const entityGraph = scan.entityGraph?.graph ?? null;

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
