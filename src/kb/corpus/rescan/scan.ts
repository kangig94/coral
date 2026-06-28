import { basename } from 'node:path';
import yaml from 'yaml';
import { isRecord } from '../../../infra/json.js';
import { isNoEntryError } from '../../../infra/fs-errors.js';
import type { EnvPort } from '../../../infra/port-types.js';
import {
  extractTitle,
  FRONTMATTER_MAX_BYTES,
  parseCommunityFrontmatter,
  parseFrontmatter,
  parseSourceFrontmatter,
  parseWikiFrontmatter,
} from '../frontmatter.js';
import { parseEntityGraph } from '../entity-graph-store.js';
import {
  noteEntryId,
  sourceEntryId,
  communityEntryId,
  wikiEntryId,
  type CommunityFrontmatter,
  type EntityGraph,
  type KbEntryId,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
  type KbWikiFrontmatter,
} from '../../entry-types.js';
import { stripMdExt } from '../../paths.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, assertWikiSlug } from '../../validation.js';
import type { CorpusMarkdownKind, CorpusStorage } from './storage.js';

export const CORPUS_SCAN_MAX_FILES_ENV = 'CORAL_KB_CORPUS_SCAN_MAX_FILES';
export const CORPUS_SCAN_MAX_FILE_BYTES_ENV = 'CORAL_KB_CORPUS_SCAN_MAX_FILE_BYTES';
export const CORPUS_SCAN_MAX_TOTAL_BYTES_ENV = 'CORAL_KB_CORPUS_SCAN_MAX_TOTAL_BYTES';
export const CORPUS_SCAN_FRONTMATTER_MAX_BYTES_ENV = 'CORAL_KB_CORPUS_SCAN_FRONTMATTER_MAX_BYTES';
export const CORPUS_SCAN_MAX_FILES = 50_000;
export const CORPUS_SCAN_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const CORPUS_SCAN_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const CORPUS_SCAN_FRONTMATTER_MAX_BYTES = FRONTMATTER_MAX_BYTES;

export type CorpusScanLimits = {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly frontmatterMaxBytes: number;
};

export class CorpusScanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusScanLimitError';
  }
}

function readPositiveIntegerEnv(envPort: Pick<EnvPort, 'get'> | undefined, key: string, fallback: number): number {
  const raw = envPort?.get(key);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCorpusScanLimits(envPort: Pick<EnvPort, 'get'> | undefined): CorpusScanLimits {
  return {
    maxFiles: readPositiveIntegerEnv(envPort, CORPUS_SCAN_MAX_FILES_ENV, CORPUS_SCAN_MAX_FILES),
    maxFileBytes: readPositiveIntegerEnv(envPort, CORPUS_SCAN_MAX_FILE_BYTES_ENV, CORPUS_SCAN_MAX_FILE_BYTES),
    maxTotalBytes: readPositiveIntegerEnv(envPort, CORPUS_SCAN_MAX_TOTAL_BYTES_ENV, CORPUS_SCAN_MAX_TOTAL_BYTES),
    frontmatterMaxBytes: readPositiveIntegerEnv(
      envPort,
      CORPUS_SCAN_FRONTMATTER_MAX_BYTES_ENV,
      CORPUS_SCAN_FRONTMATTER_MAX_BYTES,
    ),
  };
}

export type PrincipleEntryId = `principle:${string}`;
export type CorpusActiveEntryId = KbEntryId | PrincipleEntryId;

export type CorpusParsedFrontmatter =
  | KbNoteFrontmatter
  | KbSourceFrontmatter
  | CommunityFrontmatter
  | KbWikiFrontmatter;
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

export type CorpusMarkdownFileScanInput = {
  readonly kind: CorpusMarkdownKind;
  readonly path: string;
  readonly content: string;
};

export type CorpusEntityGraphScanInput = {
  readonly path: string;
  readonly content: string;
};

export type CorpusScanViewInput = {
  readonly markdownFiles: readonly CorpusMarkdownFileScanInput[];
  readonly entityGraph: CorpusEntityGraphScanInput | null;
};

export function createCorpusMarkdownFileScan(input: {
  kind: CorpusMarkdownKind;
  path: string;
  content: string;
  slug?: string;
  frontmatterMaxBytes?: number;
}): CorpusMarkdownFileScan {
  const slug = input.slug ?? stripMdExt(basename(input.path));
  const frontmatter = scanFrontmatter(input.kind, input.content, input.frontmatterMaxBytes);
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

export function createCorpusScanViewFromInput(input: CorpusScanViewInput, limits: CorpusScanLimits): CorpusScanView {
  return createCorpusScanView({
    markdownFiles: input.markdownFiles.map((file) =>
      createCorpusMarkdownFileScan({
        kind: file.kind,
        path: file.path,
        content: file.content,
        frontmatterMaxBytes: limits.frontmatterMaxBytes,
      }),
    ),
    entityGraph:
      input.entityGraph === null
        ? null
        : createCorpusEntityGraphScan({
            path: input.entityGraph.path,
            content: input.entityGraph.content,
          }),
  });
}

export function buildCorpusScanView(kb: {
  markdownRoot: string;
  corpusStorage: CorpusStorage;
  entityGraphPath(): string;
  envPort?: Pick<EnvPort, 'get'>;
}): CorpusScanView {
  const limits = resolveCorpusScanLimits(kb.envPort);
  const inputFiles: CorpusMarkdownFileScanInput[] = [];
  let totalBytes = 0;
  for (const handle of kb.corpusStorage.scan(kb.markdownRoot)) {
    if (inputFiles.length >= limits.maxFiles) {
      throw new CorpusScanLimitError(
        `KB corpus scan exceeds maximum markdown file count (${inputFiles.length + 1} files > ${limits.maxFiles} files). Increase ${CORPUS_SCAN_MAX_FILES_ENV} to allow a larger corpus.`,
      );
    }
    const sizeBytes = handle.sizeBytes();
    if (sizeBytes > limits.maxFileBytes) {
      throw new CorpusScanLimitError(
        `KB corpus scan file ${handle.path} exceeds maximum size (${sizeBytes} bytes > ${limits.maxFileBytes} bytes). Increase ${CORPUS_SCAN_MAX_FILE_BYTES_ENV} to allow larger markdown files.`,
      );
    }
    totalBytes += sizeBytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new CorpusScanLimitError(
        `KB corpus scan exceeds maximum total markdown size (${totalBytes} bytes > ${limits.maxTotalBytes} bytes). Increase ${CORPUS_SCAN_MAX_TOTAL_BYTES_ENV} to allow a larger corpus.`,
      );
    }
    inputFiles.push({
      kind: handle.kind,
      path: handle.path,
      content: handle.read(),
    });
  }
  return createCorpusScanViewFromInput(
    {
      markdownFiles: inputFiles,
      entityGraph: readEntityGraphScanInput(kb, limits),
    },
    limits,
  );
}

function readEntityGraphScanInput(
  kb: {
    corpusStorage: CorpusStorage;
    entityGraphPath(): string;
  },
  limits: CorpusScanLimits,
): CorpusEntityGraphScanInput | null {
  const path = kb.entityGraphPath();
  try {
    const sizeBytes = kb.corpusStorage.statSync(path).size;
    if (sizeBytes > limits.maxFileBytes) {
      throw new CorpusScanLimitError(
        `KB corpus entity graph ${path} exceeds maximum size (${sizeBytes} bytes > ${limits.maxFileBytes} bytes). Increase ${CORPUS_SCAN_MAX_FILE_BYTES_ENV} to allow a larger entity graph.`,
      );
    }
    return {
      path,
      content: kb.corpusStorage.readFileSync(path, 'utf-8'),
    };
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

const FRONTMATTER_OPEN_PATTERN = /^---\r?\n/;
const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function frontmatterScanLimitError(rawBlockBytes: number, frontmatterMaxBytes: number): CorpusScanLimitError {
  return new CorpusScanLimitError(
    `Frontmatter block exceeds maximum scan size (${rawBlockBytes} bytes > ${frontmatterMaxBytes} bytes). Increase ${CORPUS_SCAN_FRONTMATTER_MAX_BYTES_ENV} to allow larger frontmatter blocks.`,
  );
}

function scanFrontmatter(
  kind: CorpusMarkdownKind,
  content: string,
  frontmatterMaxBytes = CORPUS_SCAN_FRONTMATTER_MAX_BYTES,
): CorpusFrontmatterView {
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
    const rawBlock = content.replace(FRONTMATTER_OPEN_PATTERN, '');
    const rawBlockBytes = Buffer.byteLength(rawBlock, 'utf-8');
    if (rawBlockBytes > frontmatterMaxBytes) {
      return {
        status: 'error',
        rawBlock: null,
        record: null,
        typed: null,
        typedError: null,
        error: frontmatterScanLimitError(rawBlockBytes, frontmatterMaxBytes),
        bodyOffset: content.length,
      };
    }
    return {
      status: 'unterminated',
      rawBlock,
      record: null,
      typed: null,
      typedError: null,
      error: null,
      bodyOffset: content.length,
    };
  }

  const rawBlock = match[1] ?? '';
  const rawBlockBytes = Buffer.byteLength(rawBlock, 'utf-8');
  if (rawBlockBytes > frontmatterMaxBytes) {
    return {
      status: 'error',
      rawBlock: null,
      record: null,
      typed: null,
      typedError: null,
      error: frontmatterScanLimitError(rawBlockBytes, frontmatterMaxBytes),
      bodyOffset: match[0].length,
    };
  }

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
    case 'wiki':
      return parseWikiFrontmatter(content);
  }
}

function scanTitle(kind: CorpusMarkdownKind, content: string): { title: string | null; titleError: unknown | null } {
  if (kind !== 'note' && kind !== 'community' && kind !== 'wiki') {
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
    case 'wiki':
      return wikiEntryId(slug);
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
      case 'wiki':
        return wikiEntryId(assertWikiSlug(slug, 'wiki slug'));
    }
  } catch {
    return null;
  }
}
