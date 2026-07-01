import { errorMessage } from '../../../infra/error-format.js';
import { backendLog } from '../../../infra/backend-log.js';
import {
  deriveNoteIdentity,
  extractBody,
  extractPrincipleStatement,
  parseWikiBody,
  parseMembersFromBody,
  parseSummaryFromBody,
} from '../frontmatter.js';
import {
  buildCommunityIndexEntry,
  buildNoteIndexEntry,
  buildSourceIndexEntry,
  buildWikiIndexEntry,
} from '../index/records.js';
import { assertCommunitySlug, assertSourceSlug, assertWikiSlug } from '../../validation.js';
import {
  communityEntryId,
  isCommunityEntry,
  noteEntryId,
  sourceEntryId,
  vaultLinkToEntryId,
  wikiEntryId,
  type CommunityFrontmatter,
  type KbEntryId,
  type KbIndex,
  type KbNoteFrontmatter,
  type KbReindexCommunityRecord,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
  type KbSourceFrontmatter,
  type KbWikiFrontmatter,
  type ReindexResult,
} from '../../entry-types.js';
import { fileSyntaxDetector } from './incidents/file-syntax.js';
import { frontmatterShapeDetector } from './incidents/frontmatter.js';
import { identitySequenceDetector } from './incidents/identity.js';
import { referenceIntegrityDetector } from './incidents/references.js';
import type { CorpusMarkdownFileScan, CorpusScanView } from './scan.js';
import type { DetectedIncident, Detector } from './incidents/catalog.js';
import { createCorpusStructuralKeyFromRawSurfaces } from '../structural-key.js';
import {
  EMPTY_GENERATED_COMMUNITY_FRESHNESS,
  generatedCommunityRecordToReindexRecord,
  type GeneratedCommunityDocumentRecord,
  type GeneratedCommunityFreshness,
} from '../../curate/community/generated-projection-store.js';

const ALL_DETECTORS: readonly Detector[] = [
  fileSyntaxDetector,
  frontmatterShapeDetector,
  identitySequenceDetector,
  referenceIntegrityDetector,
];

export type KbReindexWikiRecord = KbWikiFrontmatter & {
  slug: string;
  path: string;
  title: string;
  body: string;
  rawContent: string;
  knowledge: KbEntryId[];
};

/**
 * Aggregates detected incidents across every typed detector. Pure projection over
 * `CorpusScanView`; does not touch storage. Callers feed the result to
 * `applyDetectedIncidentFixesLocked` (under the mutation lock).
 */
export function projectIncidents(scan: CorpusScanView): DetectedIncident[] {
  const incidents: DetectedIncident[] = [];
  for (const detector of ALL_DETECTORS) {
    for (const incident of detector.detect(scan)) {
      incidents.push(incident);
    }
  }
  return incidents;
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

export function loadWikis(scan: CorpusScanView): KbReindexWikiRecord[] {
  const wikis: KbReindexWikiRecord[] = [];

  for (const file of filesOfKind(scan, 'wiki')) {
    const filename = `${file.slug}.md`;
    try {
      const frontmatter = requireTypedFrontmatter<KbWikiFrontmatter>(file);
      const title = requireTitle(file);
      const body = extractBody(file.content);
      const sections = parseWikiBody(body);
      wikis.push({
        slug: assertWikiSlug(file.slug, 'KB wiki name'),
        path: `wiki/${filename}`,
        title,
        body,
        rawContent: file.content,
        knowledge: extractWikiKnowledgeLinks(sections.knowledge),
        ...frontmatter,
      });
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB wiki ${filename}: ${errorMessage(error)}`);
    }
  }

  return wikis;
}

export function extractWikiKnowledgeLinks(knowledge: string): KbEntryId[] {
  const links: KbEntryId[] = [];
  const pattern = /\[\[([^\]\r\n]+)\]\]/g;

  for (const match of knowledge.matchAll(pattern)) {
    const target = (match[1] ?? '').split('|', 1)[0]?.split('#', 1)[0]?.trim() ?? '';
    if (!target) {
      continue;
    }

    const entryId = vaultLinkToEntryId(`[[${target}]]`);
    if (entryId !== null) {
      links.push(entryId);
    }
  }

  return links;
}

function filesOfKind(scan: CorpusScanView, kind: CorpusMarkdownFileScan['kind']): CorpusMarkdownFileScan[] {
  const files: CorpusMarkdownFileScan[] = [];
  for (const file of scan.markdownFiles) {
    if (file.kind === kind) {
      files.push(file);
    }
  }
  return files;
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
  wikis: KbReindexWikiRecord[],
  principles: Array<[string, string]>,
  options: {
    readonly generatedCommunityDocuments?: readonly GeneratedCommunityDocumentRecord[];
    readonly generatedCommunityFreshness?: GeneratedCommunityFreshness;
  } = {},
): KbIndex {
  const entries: KbIndex['entries'] = {};
  const entityGraph = scan.entityGraph?.graph ?? null;
  const generatedCommunityDocuments = options.generatedCommunityDocuments ?? [];
  const generatedCommunityFreshness =
    options.generatedCommunityFreshness ?? EMPTY_GENERATED_COMMUNITY_FRESHNESS;
  const generatedCommunitySlugs = new Set(generatedCommunityDocuments.map((document) => document.slug));
  const structuralKey = createCorpusStructuralKeyFromRawSurfaces({
    entityGraphRaw: scan.entityGraph?.graph === null ? null : (scan.entityGraph?.content ?? null),
    communityDocuments: scan.markdownFiles
      .filter((file) => file.kind === 'community')
      .map((file) => ({ slug: file.slug, raw: file.content })),
    generatedCommunityFreshness,
    generatedCommunitySlugs,
  });

  for (const note of notes) {
    entries[noteEntryId(note.note)] = buildNoteIndexEntry({
      slug: note.note,
      title: note.title,
      body: note.body,
      tags: note.tags,
      principles: note.principles,
      source: note.source,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      related: note.related ?? [],
      ...(note.inputFingerprint === undefined ? {} : { inputFingerprint: note.inputFingerprint }),
      ...(note.entrySeq === undefined ? {} : { entrySeq: note.entrySeq }),
    });
  }

  for (const source of sources) {
    entries[sourceEntryId(source.slug)] = buildSourceIndexEntry({
      slug: source.slug,
      title: source.title,
      body: source.body,
      type: source.type,
      tags: source.tags,
      ...(source.url === undefined ? {} : { url: source.url }),
      importedAt: source.importedAt,
      related: source.related ?? [],
      ...(source.inputFingerprint === undefined ? {} : { inputFingerprint: source.inputFingerprint }),
      ...(source.entrySeq === undefined ? {} : { entrySeq: source.entrySeq }),
    });
  }

  for (const community of [
    ...communities,
    ...generatedCommunityDocuments.map((record) => generatedCommunityRecordToReindexRecord(record)),
  ]) {
    entries[communityEntryId(community.slug)] = buildCommunityIndexEntry({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
      ...(community.summaryInputFingerprint === undefined
        ? {}
        : { summaryInputFingerprint: community.summaryInputFingerprint }),
      createdAt: community.createdAt,
      updatedAt: community.updatedAt,
    });
  }

  for (const wiki of wikis) {
    entries[wikiEntryId(wiki.slug)] = buildWikiIndexEntry({
      slug: wiki.slug,
      title: wiki.title,
      tags: wiki.tags,
      createdAt: wiki.createdAt,
      updatedAt: wiki.updatedAt,
      knowledge: wiki.knowledge,
    });
  }

  const principleIndex: KbIndex['principles'] = {};
  for (const [name, statement] of principles) {
    principleIndex[name] = statement;
  }

  return {
    entries,
    principles: principleIndex,
    entityMeta: entityGraph?.entityMeta ?? {},
    relationships: entityGraph?.relationships ?? [],
    ...(structuralKey === undefined ? {} : { structuralKey }),
    generatedCommunityGeneration: generatedCommunityFreshness.generatedCommunityGeneration,
    generatedCommunityDocsHash: generatedCommunityFreshness.generatedCommunityDocsHash,
  };
}

export function buildCounts(
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  communities: KbReindexCommunityRecord[],
  wikis: KbReindexWikiRecord[],
  principles: Array<[string, string]>,
  index: KbIndex,
): Pick<
  ReindexResult,
  | 'notes'
  | 'sources'
  | 'communities'
  | 'wikis'
  | 'principles'
  | 'tags'
  | 'entities'
  | 'relationships'
  | 'entityCoverage'
> {
  const entityMeta = index.entityMeta;
  const uniqueTags = new Set<string>();
  let communityCount = 0;
  for (const note of notes) {
    for (const tag of note.tags) {
      uniqueTags.add(tag);
    }
  }
  for (const source of sources) {
    for (const tag of source.tags) {
      uniqueTags.add(tag);
    }
  }
  for (const community of communities) {
    for (const member of community.members) {
      uniqueTags.add(member);
    }
  }
  for (const entry of Object.values(index.entries)) {
    if (!isCommunityEntry(entry)) {
      continue;
    }
    communityCount += 1;
    for (const member of entry.members) {
      uniqueTags.add(member);
    }
  }
  for (const wiki of wikis) {
    for (const tag of wiki.tags) {
      uniqueTags.add(tag);
    }
  }
  const entityNames = Object.keys(entityMeta);
  let coveredTags = 0;
  for (const tag of uniqueTags) {
    if (Object.prototype.hasOwnProperty.call(entityMeta, tag)) {
      coveredTags += 1;
    }
  }
  return {
    notes: notes.length,
    sources: sources.length,
    communities: communityCount,
    wikis: wikis.length,
    principles: principles.length,
    tags: uniqueTags.size,
    entities: entityNames.length,
    relationships: index.relationships?.length ?? 0,
    entityCoverage: uniqueTags.size === 0 ? 1 : coveredTags / uniqueTags.size,
  };
}
