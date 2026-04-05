import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCommunityFrontmatter,
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
} from './frontmatter.js';
import { parseMembersFromBody, parseSummaryFromBody } from './community-detection.js';
import { communityPathFromName, memoDir, notePathFromName, principlePathFromName, sourcePathFromName } from './paths.js';
import type { CommunityFrontmatter, KbNoteFrontmatter, KbReadInput, KbReadResult, KbSourceFrontmatter } from './types.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug } from './validation.js';

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

export type KbLoadedCommunity = {
  raw: string;
  frontmatter: CommunityFrontmatter;
  title: string;
  body: string;
};

type KbReadSelector = {
  kind?: 'community' | 'source';
  slug: string;
};

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
  return {
    raw,
    frontmatter: parseCommunityFrontmatter(raw),
    title: extractTitle(raw),
    body: extractBody(raw),
  };
}

const MEMO_FILENAME_PATTERN = /^\d{8}-\d{6}-.+$/;

export function parseReadSelector(selector: string): KbReadSelector {
  const separatorIndex = selector.indexOf(':');
  if (separatorIndex === -1) {
    return {
      slug: assertNoteSlug(selector, 'note'),
    };
  }

  const kind = selector.slice(0, separatorIndex);
  const slug = selector.slice(separatorIndex + 1);

  if (kind === 'sources') {
    return {
      kind: 'source',
      slug: assertSourceSlug(slug, 'source'),
    };
  }

  if (kind === 'communities') {
    return {
      kind: 'community',
      slug: assertCommunitySlug(slug, 'community'),
    };
  }

  return {
    slug: assertNoteSlug(selector, 'note'),
  };
}

function readSourceEntry(source: string): KbReadResult | null {
  const sourcePath = sourcePathFromName(source);
  if (!existsSync(sourcePath)) {
    return null;
  }

  const { frontmatter, title, body } = loadKbSource(sourcePath);
  return {
    kind: 'source',
    note: source,
    title,
    content: body,
    tags: frontmatter.tags,
    principles: [],
  };
}

function readCommunityEntry(community: string): KbReadResult | null {
  const communityPath = communityPathFromName(community);
  if (!existsSync(communityPath)) {
    return null;
  }

  const { frontmatter, title, body } = loadKbCommunity(communityPath);
  const members = parseMembersFromBody(body);
  const summary = parseSummaryFromBody(body);
  return {
    kind: 'community',
    note: community,
    title,
    content: body,
    tags: [],
    principles: [],
    members,
    ...(summary === undefined ? {} : { summary }),
    updatedAt: frontmatter.updatedAt,
  };
}

export function readEntry(input: KbReadInput, projectRoot?: string): KbReadResult {
  const selector = parseReadSelector(input.note);

  if (selector.kind === 'source') {
    const sourceEntry = readSourceEntry(selector.slug);
    if (sourceEntry !== null) {
      return sourceEntry;
    }

    throw new Error(`KB entry not found: ${input.note}`);
  }

  if (selector.kind === 'community') {
    const communityEntry = readCommunityEntry(selector.slug);
    if (communityEntry !== null) {
      return communityEntry;
    }

    throw new Error(`KB entry not found: ${input.note}`);
  }

  const note = selector.slug;

  if (projectRoot && MEMO_FILENAME_PATTERN.test(note)) {
    const memoPath = join(memoDir(projectRoot), `${note}.md`);
    if (existsSync(memoPath)) {
      const raw = readFileSync(memoPath, 'utf-8');
      return {
        kind: 'memo',
        note,
        title: note,
        content: extractBody(raw),
        tags: [],
        principles: [],
      };
    }
  }

  const notePath = notePathFromName(note);
  if (existsSync(notePath)) {
    const { frontmatter, title, body } = loadKbNote(notePath);
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

  const communityEntry = readCommunityEntry(note);
  if (communityEntry !== null) {
    return communityEntry;
  }

  const sourceEntry = readSourceEntry(note);
  if (sourceEntry !== null) {
    return sourceEntry;
  }

  const principlePath = principlePathFromName(note);
  if (existsSync(principlePath)) {
    const raw = readFileSync(principlePath, 'utf-8');
    const updatedAtMatch = raw.match(/^updatedAt:\s*(.+)$/m);
    return {
      kind: 'principle',
      note,
      title: note,
      content: extractPrincipleStatement(raw),
      rawContent: raw,
      tags: [],
      principles: [],
      updatedAt: updatedAtMatch?.[1]?.trim(),
    };
  }

  throw new Error(`KB entry not found: ${input.note}`);
}
