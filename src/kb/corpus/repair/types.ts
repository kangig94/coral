import { basename } from 'node:path';
import yaml from 'yaml';
import { isRecord } from '../../../shared/utils.js';
import {
  extractTitle,
  parseCommunityFrontmatter,
  parseFrontmatter,
  parseSourceFrontmatter,
} from '../../corpus/frontmatter.js';
import {
  noteEntryId,
  sourceEntryId,
  communityEntryId,
  type CommunityFrontmatter,
  type KbEntryId,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
} from '../../entry-types.js';
import { stripMdExt } from '../../paths.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug } from '../../validation.js';
import type { RepairIncidentId, RepairIncidentLocus } from './incident-ids.js';

export type { RepairIncidentId, RepairLocus } from './incident-ids.js';

export type DetectedIncident = {
  [IncidentId in RepairIncidentId]: {
    locus: RepairIncidentLocus<IncidentId>;
    canonical: IncidentId;
    entryId: string;
    signals: Record<string, unknown>;
  };
}[RepairIncidentId];

export interface Detector {
  detect(corpus: CorpusScanView): DetectedIncident[];
}

export type CorpusMarkdownKind = 'note' | 'source' | 'community' | 'principle';
export type PrincipleEntryId = `principle:${string}`;
export type CorpusActiveEntryId = KbEntryId | PrincipleEntryId;

export type CorpusParsedFrontmatter = KbNoteFrontmatter | KbSourceFrontmatter | CommunityFrontmatter;
export type CorpusFrontmatterStatus = 'absent' | 'parsed' | 'unterminated' | 'error';

export interface CorpusFrontmatterView {
  status: CorpusFrontmatterStatus;
  rawBlock: string | null;
  record: Record<string, unknown> | null;
  typed: CorpusParsedFrontmatter | null;
  typedError: unknown | null;
  error: unknown | null;
  bodyOffset: number;
}

export interface CorpusMarkdownFileScan {
  kind: CorpusMarkdownKind;
  slug: string;
  path: string;
  entryId: string;
  activeEntryId: CorpusActiveEntryId | null;
  content: string;
  frontmatter: CorpusFrontmatterView;
  title: string | null;
  titleError: unknown | null;
}

export interface CorpusEntityGraphRelationshipScan {
  evidence: readonly string[];
}

// Synthetic scan identifier for the detached entity-graph artifact; not a valid KbEntryId.
export const ENTITY_GRAPH_SCAN_ENTRY_ID = 'entity-graph:.entity-graph.json' as const;

export interface CorpusEntityGraphScan {
  entryId: typeof ENTITY_GRAPH_SCAN_ENTRY_ID;
  path: string;
  content: string;
  relationships: readonly CorpusEntityGraphRelationshipScan[] | null;
  error: unknown | null;
}

export interface CorpusScanView {
  markdownFiles: readonly CorpusMarkdownFileScan[];
  entityGraph: CorpusEntityGraphScan | null;
  activeEntryIds: ReadonlySet<KbEntryId>;
  principleSlugs: ReadonlySet<string>;
}

export function createCorpusMarkdownFileScan(input: {
  kind: CorpusMarkdownKind;
  path: string;
  content: string;
  slug?: string;
}): CorpusMarkdownFileScan {
  const slug = input.slug ?? stripMdExt(basename(input.path));
  const frontmatter = scanFrontmatter(input.kind, input.content);
  const { title, titleError } = scanTitle(input.kind, input.content);

  return {
    kind: input.kind,
    slug,
    path: input.path,
    entryId: buildEntryId(input.kind, slug),
    activeEntryId: buildActiveEntryId(input.kind, slug),
    content: input.content,
    frontmatter,
    title,
    titleError,
  };
}

export function createCorpusEntityGraphScan(input: { content: string; path?: string }): CorpusEntityGraphScan {
  try {
    const parsed: unknown = JSON.parse(input.content);
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.relationships)) {
      throw new Error('Entity graph must be an object with a relationships array');
    }

    return {
      entryId: ENTITY_GRAPH_SCAN_ENTRY_ID,
      path: input.path ?? '.entity-graph.json',
      content: input.content,
      relationships: parsed.relationships.map((relationship, index) => {
        if (!isPlainRecord(relationship) || !Array.isArray(relationship.evidence)) {
          throw new Error(`relationships[${index}] must include an evidence array`);
        }

        const evidence = relationship.evidence.map((entry, evidenceIndex) => {
          if (typeof entry !== 'string') {
            throw new Error(`relationships[${index}].evidence[${evidenceIndex}] must be a string`);
          }
          return entry;
        });

        return { evidence };
      }),
      error: null,
    };
  } catch (error: unknown) {
    return {
      entryId: ENTITY_GRAPH_SCAN_ENTRY_ID,
      path: input.path ?? '.entity-graph.json',
      content: input.content,
      relationships: null,
      error,
    };
  }
}

/** Builds the detector view over scanned markdown files plus the optional entity-graph artifact. */
export function createCorpusScanView(input: {
  markdownFiles: readonly CorpusMarkdownFileScan[];
  entityGraph?: CorpusEntityGraphScan | null;
}): CorpusScanView {
  const activeEntryIds = new Set<KbEntryId>();
  const principleSlugs = new Set<string>();

  for (const entry of input.markdownFiles) {
    if (entry.kind === 'principle') {
      if (entry.activeEntryId !== null) {
        principleSlugs.add(entry.activeEntryId.slice('principle:'.length));
      }
      continue;
    }

    if (entry.activeEntryId !== null) {
      activeEntryIds.add(entry.activeEntryId as KbEntryId);
    }
  }

  return {
    markdownFiles: [...input.markdownFiles],
    entityGraph: input.entityGraph ?? null,
    activeEntryIds,
    principleSlugs,
  };
}

const FRONTMATTER_OPEN_PATTERN = /^---\r?\n/;
const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function scanFrontmatter(kind: CorpusMarkdownKind, content: string): CorpusFrontmatterView {
  if (!FRONTMATTER_OPEN_PATTERN.test(content)) {
    return {
      status: 'absent',
      rawBlock: null,
      record: null,
      typed: null,
      typedError: null,
      error: null,
      bodyOffset: 0,
    };
  }

  const match = content.match(FRONTMATTER_BLOCK_PATTERN);
  if (match === null) {
    return {
      status: 'unterminated',
      rawBlock: content.replace(FRONTMATTER_OPEN_PATTERN, ''),
      record: null,
      typed: null,
      typedError: null,
      error: null,
      bodyOffset: content.length,
    };
  }

  const rawBlock = match[1] ?? '';

  try {
    const parsed = yaml.parse(rawBlock) as unknown;
    if (!isPlainRecord(parsed)) {
      throw new Error('Frontmatter must be a mapping');
    }

    let typed: CorpusParsedFrontmatter | null = null;
    let typedError: unknown | null = null;
    try {
      typed = parseTypedFrontmatter(kind, content);
    } catch (error: unknown) {
      typedError = error;
    }

    return {
      status: 'parsed',
      rawBlock,
      record: parsed,
      typed,
      typedError,
      error: null,
      bodyOffset: match[0].length,
    };
  } catch (error: unknown) {
    return {
      status: 'error',
      rawBlock,
      record: null,
      typed: null,
      typedError: null,
      error,
      bodyOffset: match[0].length,
    };
  }
}

function parseTypedFrontmatter(kind: CorpusMarkdownKind, content: string): CorpusParsedFrontmatter | null {
  switch (kind) {
    case 'note':
      return parseFrontmatter(content);
    case 'source':
      return parseSourceFrontmatter(content);
    case 'community':
      return parseCommunityFrontmatter(content);
    case 'principle':
      return null;
  }
}

function scanTitle(kind: CorpusMarkdownKind, content: string): { title: string | null; titleError: unknown | null } {
  if (kind !== 'note' && kind !== 'community') {
    return {
      title: null,
      titleError: null,
    };
  }

  try {
    return {
      title: extractTitle(content),
      titleError: null,
    };
  } catch (error: unknown) {
    return {
      title: null,
      titleError: error,
    };
  }
}

function buildEntryId(kind: CorpusMarkdownKind, slug: string): string {
  switch (kind) {
    case 'note':
      return noteEntryId(slug);
    case 'source':
      return sourceEntryId(slug);
    case 'community':
      return communityEntryId(slug);
    case 'principle':
      return `principle:${slug}`;
  }
}

function buildActiveEntryId(kind: CorpusMarkdownKind, slug: string): CorpusActiveEntryId | null {
  try {
    switch (kind) {
      case 'note':
        return noteEntryId(assertNoteSlug(slug, 'note slug'));
      case 'source':
        return sourceEntryId(assertSourceSlug(slug, 'source slug'));
      case 'community':
        return communityEntryId(assertCommunitySlug(slug, 'community slug'));
      case 'principle':
        return `principle:${assertNoteSlug(slug, 'principle slug')}`;
    }
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}
