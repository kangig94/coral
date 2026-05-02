import { basename } from 'node:path';
import yaml from 'yaml';
import { isRecord } from '../../../infra/json.js';
import { isNoEntryError } from '../../../infra/fs-errors.js';
import { extractTitle, parseCommunityFrontmatter, parseFrontmatter, parseSourceFrontmatter } from '../frontmatter.js';
import { parseEntityGraph } from '../entity-graph-store.js';
import {
  noteEntryId,
  sourceEntryId,
  communityEntryId,
  type CommunityFrontmatter,
  type EntityGraph,
  type KbEntryId,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
} from '../../entry-types.js';
import { stripMdExt } from '../../paths.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug } from '../../validation.js';
import type { CorpusMarkdownKind, CorpusStorage } from './storage.js';

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

// Synthetic scan identifier for the detached entity-graph artifact; not a valid KbEntryId.
export const ENTITY_GRAPH_SCAN_ENTRY_ID = 'entity-graph:.entity-graph.json' as const;

export interface CorpusEntityGraphScan {
  entryId: typeof ENTITY_GRAPH_SCAN_ENTRY_ID;
  path: string;
  content: string;
  graph: EntityGraph | null;
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
    if (input.content.includes('<<<<<<<')) {
      throw new Error('Merge conflict markers detected.');
    }
    const graph = parseEntityGraph(JSON.parse(input.content) as unknown);
    return {
      entryId: ENTITY_GRAPH_SCAN_ENTRY_ID,
      path: input.path ?? '.entity-graph.json',
      content: input.content,
      graph,
      error: null,
    };
  } catch (error: unknown) {
    return {
      entryId: ENTITY_GRAPH_SCAN_ENTRY_ID,
      path: input.path ?? '.entity-graph.json',
      content: input.content,
      graph: null,
      error,
    };
  }
}

/** Builds the detector view over scanned markdown files plus the optional entity-graph artifact. */
export function createCorpusScanView(input: {
  markdownFiles: readonly CorpusMarkdownFileScan[];
  entityGraph: CorpusEntityGraphScan | null;
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
    entityGraph: input.entityGraph,
    activeEntryIds,
    principleSlugs,
  };
}

export function buildCorpusScanView(kb: {
  markdownRoot: string;
  corpusStorage: CorpusStorage;
  entityGraphPath(): string;
}): CorpusScanView {
  const markdownFiles: CorpusMarkdownFileScan[] = [];
  for (const handle of kb.corpusStorage.scan(kb.markdownRoot)) {
    markdownFiles.push(
      createCorpusMarkdownFileScan({
        kind: handle.kind,
        path: handle.path,
        content: handle.read(),
      }),
    );
  }
  return createCorpusScanView({
    markdownFiles,
    entityGraph: readEntityGraphScan(kb),
  });
}

function readEntityGraphScan(kb: {
  corpusStorage: CorpusStorage;
  entityGraphPath(): string;
}): CorpusEntityGraphScan | null {
  const path = kb.entityGraphPath();
  try {
    const content = kb.corpusStorage.readFileSync(path, 'utf-8');
    return createCorpusEntityGraphScan({ content, path });
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
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
    if (!isRecord(parsed)) {
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
