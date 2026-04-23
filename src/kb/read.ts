import { existsSync, readFileSync } from 'node:fs';
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
} from './corpus/frontmatter.js';
import { type CommunityFrontmatter, type KbNoteFrontmatter, type KbReadInput, type KbReadResult, type KbSourceFrontmatter } from './entry-types.js';
import { memoDir, notePathFromName, principlePathFromName, sourcePathFromName, communityPathFromName } from './paths.js';
import { expandKbReadSelector, parseKbSelector, type KbResolvedReadSelector } from './read-contract.js';
import type { RuntimeStoragePort } from '../runtime/ports.js';

export type KbReadStorage = Pick<RuntimeStoragePort, 'existsSync' | 'readFileSync'>;

export type KbReadPathResolver = {
  notePath(note: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
};

export type KbReadOptions = {
  projectRoot?: string;
  storage?: KbReadStorage;
  paths?: Partial<KbReadPathResolver>;
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

export type KbLoadedCommunity = CommunityFrontmatter & {
  raw: string;
  title: string;
  body: string;
};

const nodeStorage: KbReadStorage = {
  existsSync,
  readFileSync,
};

const MEMO_FILENAME_PATTERN = /^\d{8}-\d{6}-.+$/;

function resolveReadPaths(paths?: Partial<KbReadPathResolver>): KbReadPathResolver {
  return {
    notePath: paths?.notePath ?? ((note) => notePathFromName(note)),
    sourcePath: paths?.sourcePath ?? ((source) => sourcePathFromName(source)),
    communityPath: paths?.communityPath ?? ((community) => communityPathFromName(community)),
    principlePath: paths?.principlePath ?? ((principle) => principlePathFromName(principle)),
  };
}

export function loadKbNote(notePath: string): KbLoadedNote {
  const raw = readFileSync(notePath, 'utf-8');
  return {
    raw,
    frontmatter: parseFrontmatter(raw),
    title: extractTitle(raw),
    body: extractBody(raw),
  };
}

export function loadKbSource(sourcePath: string): KbLoadedSource {
  const raw = readFileSync(sourcePath, 'utf-8');
  const frontmatter = parseSourceFrontmatter(raw);
  return {
    raw,
    frontmatter,
    title: frontmatter.title,
    body: extractBody(raw),
  };
}

export function loadKbCommunity(communityPath: string): KbLoadedCommunity {
  const raw = readFileSync(communityPath, 'utf-8');
  const frontmatter = parseCommunityFrontmatter(raw);
  return {
    ...frontmatter,
    raw,
    title: extractTitle(raw),
    body: extractBody(raw),
  };
}

function readSourceEntry(
  source: string,
  storage: KbReadStorage,
  paths: KbReadPathResolver,
): KbReadResult | null {
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
): KbReadResult | null {
  const communityPath = paths.communityPath(community);
  if (!storage.existsSync(communityPath)) {
    return null;
  }

  const raw = storage.readFileSync(communityPath, 'utf-8');
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

function readCandidateEntry(
  candidate: KbResolvedReadSelector,
  storage: KbReadStorage,
  paths: KbReadPathResolver,
  projectRoot?: string,
): KbReadResult | null {
  if (candidate.kind === 'source') {
    return readSourceEntry(candidate.slug, storage, paths);
  }

  if (candidate.kind === 'community') {
    return readCommunityEntry(candidate.slug, storage, paths);
  }

  if (candidate.kind === 'memo') {
    if (projectRoot === undefined || !MEMO_FILENAME_PATTERN.test(candidate.slug)) {
      return null;
    }

    const memoPath = join(memoDir(projectRoot), `${candidate.slug}.md`);
    if (!storage.existsSync(memoPath)) {
      return null;
    }

    const raw = storage.readFileSync(memoPath, 'utf-8');
    return {
      kind: 'memo',
      note: candidate.slug,
      title: candidate.slug,
      content: extractBody(raw),
      tags: [],
      principles: [],
    };
  }

  if (candidate.kind === 'note') {
    const notePath = paths.notePath(candidate.slug);
    if (!storage.existsSync(notePath)) {
      return null;
    }

    const raw = storage.readFileSync(notePath, 'utf-8');
    const frontmatter = parseFrontmatter(raw);
    return {
      kind: 'note',
      note: candidate.slug,
      title: extractTitle(raw),
      content: extractBody(raw),
      tags: frontmatter.tags,
      principles: frontmatter.principles,
      updatedAt: frontmatter.updatedAt,
    };
  }

  const principlePath = paths.principlePath(candidate.slug);
  if (!storage.existsSync(principlePath)) {
    return null;
  }

  const raw = storage.readFileSync(principlePath, 'utf-8');
  const updatedAtMatch = raw.match(/^updatedAt:\s*(.+)$/m);
  return {
    kind: 'principle',
    note: candidate.slug,
    title: candidate.slug,
    content: extractPrincipleStatement(raw),
    rawContent: raw,
    tags: [],
    principles: [],
    updatedAt: updatedAtMatch?.[1]?.trim(),
  };
}

export function readEntry(input: KbReadInput, options: string | KbReadOptions = {}): KbReadResult {
  const resolved = typeof options === 'string' ? { projectRoot: options } : options;
  const storage = resolved.storage ?? nodeStorage;
  const paths = resolveReadPaths(resolved.paths);
  const selector = parseKbSelector(input.note);

  for (const candidate of expandKbReadSelector(selector)) {
    const entry = readCandidateEntry(candidate, storage, paths, resolved.projectRoot);
    if (entry !== null) {
      return entry;
    }
  }

  throw new Error(`KB entry not found: ${input.note}`);
}
