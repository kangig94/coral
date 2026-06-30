import { join } from 'node:path';

import {
  parseCommunityFrontmatter,
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseFrontmatter,
  parseMembersFromBody,
  parseSourceFrontmatter,
  parseSummaryFromBody,
  parseWikiBody,
  parseWikiFrontmatter,
} from './corpus/frontmatter.js';
import {
  type KbNoteFrontmatter,
  type KbEntryId,
  type KbReadInput,
  type KbReadResult,
  type KbSourceFrontmatter,
  type KbWikiFrontmatter,
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  wikiEntryId,
} from './entry-types.js';
import { memoDir } from './paths.js';
import { expandKbReadSelector, parseKbSelector, type KbReadKind, type KbResolvedReadSelector } from './selector.js';
import type { StoragePort } from '../infra/port-types.js';

export type KbReadStorage = Pick<StoragePort, 'existsSync' | 'readFileSync'>;

export type KbReadPathResolver = {
  notePath(note: string): string;
  wikiPath(slug: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
};

export type KbReadCommunityDocumentProvider = {
  readGeneratedCommunityDocument(slug: string): { readonly content: string } | null;
};

export type KbReadOptions = {
  storage: KbReadStorage;
  /** Resolved per-project data dir (`runtime.paths.projectData(projectRoot)`); memo reads only. */
  projectDataDir?: string;
  paths?: KbReadPathResolver;
  communityDocumentProvider?: KbReadCommunityDocumentProvider;
};

export type KbResolvedReadResult = {
  result: KbReadResult;
  resolvedEntryId: KbEntryId | null;
};

export type KbLoadedNote = {
  raw: string;
  frontmatter: KbNoteFrontmatter;
  title: string;
  body: string;
};

export type KbLoadedSource = {
  raw: string;
  frontmatter: KbSourceFrontmatter;
  title: string;
  body: string;
};

export type KbLoadedWiki = {
  raw: string;
  frontmatter: KbWikiFrontmatter;
  title: string;
  body: string;
};

const MEMO_FILENAME_PATTERN = /^\d{8}-\d{6}-.+$/;

function resolveReadPaths(paths?: KbReadPathResolver): KbReadPathResolver {
  if (paths === undefined) {
    throw new Error('KB read paths must be provided explicitly.');
  }
  return paths;
}

export function loadKbNote(storage: Pick<StoragePort, 'readFileSync'>, notePath: string): KbLoadedNote {
  const raw = storage.readFileSync(notePath, 'utf-8');
  return {
    raw,
    frontmatter: parseFrontmatter(raw),
    title: extractTitle(raw),
    body: extractBody(raw),
  };
}

export function loadKbSource(storage: Pick<StoragePort, 'readFileSync'>, sourcePath: string): KbLoadedSource {
  const raw = storage.readFileSync(sourcePath, 'utf-8');
  const frontmatter = parseSourceFrontmatter(raw);
  return {
    raw,
    frontmatter,
    title: frontmatter.title,
    body: extractBody(raw),
  };
}

export function loadKbWiki(storage: Pick<StoragePort, 'readFileSync'>, wikiPath: string): KbLoadedWiki {
  const raw = storage.readFileSync(wikiPath, 'utf-8');
  const body = extractBody(raw);
  parseWikiBody(body);
  return {
    raw,
    frontmatter: parseWikiFrontmatter(raw),
    title: extractTitle(raw),
    body,
  };
}

function readSourceEntry(source: string, storage: KbReadStorage, paths: KbReadPathResolver): KbReadResult | null {
  const sourcePath = paths.sourcePath(source);
  if (!storage.existsSync(sourcePath)) {
    return null;
  }

  const raw = storage.readFileSync(sourcePath, 'utf-8');
  const frontmatter = parseSourceFrontmatter(raw);
  return {
    kind: 'source',
    note: source,
    title: frontmatter.title,
    content: extractBody(raw),
    tags: frontmatter.tags,
    principles: [],
  };
}

function readCommunityEntry(
  community: string,
  storage: KbReadStorage,
  paths: KbReadPathResolver,
  provider?: KbReadCommunityDocumentProvider,
): KbReadResult | null {
  const communityPath = paths.communityPath(community);
  let raw: string | null;
  if (storage.existsSync(communityPath)) {
    raw = storage.readFileSync(communityPath, 'utf-8');
  } else {
    raw = provider?.readGeneratedCommunityDocument(community)?.content ?? null;
  }
  if (raw === null) {
    return null;
  }

  const frontmatter = parseCommunityFrontmatter(raw);
  const body = extractBody(raw);
  const summary = parseSummaryFromBody(body);
  return {
    kind: 'community',
    note: community,
    title: extractTitle(raw),
    content: body,
    tags: [],
    principles: [],
    members: parseMembersFromBody(body),
    level: frontmatter.level,
    ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
    ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
    ...(summary === undefined ? {} : { summary }),
    updatedAt: frontmatter.updatedAt,
  };
}

function readMemoEntry(slug: string, storage: KbReadStorage, projectDataDir: string | undefined): KbReadResult | null {
  if (projectDataDir === undefined) {
    return null;
  }

  const memoPath = join(memoDir(projectDataDir), `${slug}.md`);
  if (!storage.existsSync(memoPath)) {
    return null;
  }

  const raw = storage.readFileSync(memoPath, 'utf-8');
  return {
    kind: 'memo',
    note: slug,
    title: slug,
    content: extractBody(raw),
    tags: [],
    principles: [],
  };
}

function readNoteEntry(note: string, storage: KbReadStorage, paths: KbReadPathResolver): KbReadResult | null {
  const notePath = paths.notePath(note);
  if (!storage.existsSync(notePath)) {
    return null;
  }

  const { frontmatter, title, body } = loadKbNote(storage, notePath);
  return {
    kind: 'note',
    note,
    title,
    content: body,
    tags: frontmatter.tags,
    principles: frontmatter.principles,
    updatedAt: frontmatter.updatedAt,
  };
}

function readWikiEntry(slug: string, storage: KbReadStorage, paths: KbReadPathResolver): KbReadResult | null {
  const wikiPath = paths.wikiPath(slug);
  if (!storage.existsSync(wikiPath)) {
    return null;
  }

  const { frontmatter, title, body } = loadKbWiki(storage, wikiPath);
  return {
    kind: 'wiki',
    note: slug,
    title,
    content: body,
    tags: frontmatter.tags,
    principles: [],
    updatedAt: frontmatter.updatedAt,
  };
}

function readPrincipleEntry(principle: string, storage: KbReadStorage, paths: KbReadPathResolver): KbReadResult | null {
  const principlePath = paths.principlePath(principle);
  if (!storage.existsSync(principlePath)) {
    return null;
  }

  const raw = storage.readFileSync(principlePath, 'utf-8');
  const updatedAtMatch = raw.match(/^updatedAt:\s*(.+)$/m);
  return {
    kind: 'principle',
    note: principle,
    title: principle,
    content: extractPrincipleStatement(raw),
    rawContent: raw,
    tags: [],
    principles: [],
    updatedAt: updatedAtMatch?.[1]?.trim(),
  };
}

export function readEntryByKind(kind: KbReadKind, slug: string, options: KbReadOptions): KbReadResult | null {
  const storage = options.storage;
  if (kind === 'memo') {
    return readMemoEntry(slug, storage, options.projectDataDir);
  }

  const paths = resolveReadPaths(options.paths);
  if (kind === 'note') {
    return readNoteEntry(slug, storage, paths);
  }
  if (kind === 'wiki') {
    return readWikiEntry(slug, storage, paths);
  }
  if (kind === 'community') {
    return readCommunityEntry(slug, storage, paths, options.communityDocumentProvider);
  }
  if (kind === 'source') {
    return readSourceEntry(slug, storage, paths);
  }
  return readPrincipleEntry(slug, storage, paths);
}

function readCandidateEntry(
  candidate: KbResolvedReadSelector,
  storage: KbReadStorage,
  paths: KbReadPathResolver,
  projectDataDir?: string,
  communityDocumentProvider?: KbReadCommunityDocumentProvider,
): KbReadResult | null {
  if (candidate.kind === 'memo') {
    if (!MEMO_FILENAME_PATTERN.test(candidate.slug)) {
      return null;
    }
    return readMemoEntry(candidate.slug, storage, projectDataDir);
  }

  if (candidate.kind === 'note') {
    return readNoteEntry(candidate.slug, storage, paths);
  }

  if (candidate.kind === 'wiki') {
    return readWikiEntry(candidate.slug, storage, paths);
  }

  if (candidate.kind === 'community') {
    return readCommunityEntry(candidate.slug, storage, paths, communityDocumentProvider);
  }

  if (candidate.kind === 'source') {
    return readSourceEntry(candidate.slug, storage, paths);
  }

  return readPrincipleEntry(candidate.slug, storage, paths);
}

function resolvedEntryIdForCandidate(candidate: KbResolvedReadSelector): KbEntryId | null {
  if (candidate.kind === 'note') {
    return noteEntryId(candidate.slug);
  }
  if (candidate.kind === 'wiki') {
    return wikiEntryId(candidate.slug);
  }
  if (candidate.kind === 'community') {
    return communityEntryId(candidate.slug);
  }
  if (candidate.kind === 'source') {
    return sourceEntryId(candidate.slug);
  }
  return null;
}

export function readEntryWithResolvedId(input: KbReadInput, options: KbReadOptions): KbResolvedReadResult {
  const storage = options.storage;
  const paths = resolveReadPaths(options.paths);
  const selector = parseKbSelector(input.note);

  for (const candidate of expandKbReadSelector(selector)) {
    const entry = readCandidateEntry(
      candidate,
      storage,
      paths,
      options.projectDataDir,
      options.communityDocumentProvider,
    );
    if (entry !== null) {
      return {
        result: entry,
        resolvedEntryId: resolvedEntryIdForCandidate(candidate),
      };
    }
  }

  throw new Error(`KB entry not found: ${input.note}`);
}

export function readEntry(input: KbReadInput, options: KbReadOptions): KbReadResult {
  return readEntryWithResolvedId(input, options).result;
}
