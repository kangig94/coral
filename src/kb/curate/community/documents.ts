import { join } from 'node:path';
import { unlinkIfExists } from '../../../infra/fs-errors.js';
import {
  captureCommunityManifestDelta,
  captureRemovedCommunityManifestDelta,
} from '../../corpus/manifest-authority.js';
import {
  extractBody,
  extractTitle,
  parseCommunityFrontmatter,
  parseMembersFromBody,
  parseSummaryFromBody,
  serializeCommunityFrontmatter,
} from '../../corpus/frontmatter.js';
import { sortedMarkdownEntries } from '../../corpus/markdown-entries.js';
import { writeFileAtomic } from '../../corpus/file-atomic.js';
import { stripMdExt } from '../../paths.js';
import type { KbMutationEffects, KbRuntime } from '../../contract.js';
import type { CommunityDocument, DetectedCommunity, ExistingGeneratedCommunity } from './contracts.js';

type BuildCommunityDocumentsOptions = {
  priorGeneratedCommunities: ExistingGeneratedCommunity[];
  today: string;
};

function renderMembersSection(members: string[]): string {
  return ['## Members', '', ...members.map((member) => `- #${member}`)].join('\n');
}

function renderChildrenSection(children: string[]): string {
  return ['## Children', '', ...children.map((child) => `- ${child}`)].join('\n');
}

export function loadExistingCommunityState(kb: Pick<KbRuntime, 'communitiesDir' | 'storagePort'>): {
  generated: ExistingGeneratedCommunity[];
  reservedSlugs: Set<string>;
} {
  const generated: ExistingGeneratedCommunity[] = [];
  const reservedSlugs = new Set<string>();
  const storage = kb.storagePort;

  for (const entry of sortedMarkdownEntries(storage, kb.communitiesDir())) {
    const slug = stripMdExt(entry);
    const raw = storage.readFileSync(join(kb.communitiesDir(), entry), 'utf-8');

    try {
      const frontmatter = parseCommunityFrontmatter(raw);
      const body = extractBody(raw);
      generated.push({
        slug,
        title: extractTitle(raw),
        level: frontmatter.level,
        members: parseMembersFromBody(body),
        ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
        ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
        summary: parseSummaryFromBody(body),
        createdAt: frontmatter.createdAt,
        updatedAt: frontmatter.updatedAt,
      });
    } catch {
      reservedSlugs.add(slug);
    }
  }

  return { generated, reservedSlugs };
}

export function renderCommunityDocument(document: {
  title: string;
  members: string[];
  level?: number;
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}): string {
  const frontmatter = serializeCommunityFrontmatter({
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    level: document.level,
    ...(document.parent === undefined ? {} : { parent: document.parent }),
    ...(document.children === undefined ? {} : { children: document.children }),
  });
  const summarySection = document.summary === undefined ? '' : `## Summary\n\n${document.summary}\n\n`;
  const childrenSection =
    document.children === undefined || document.children.length === 0
      ? ''
      : `\n\n${renderChildrenSection(document.children)}`;

  return `${frontmatter}# ${document.title}\n\n${summarySection}${renderMembersSection(document.members)}${childrenSection}\n`;
}

export function buildCommunityDocuments(
  communities: DetectedCommunity[],
  options: BuildCommunityDocumentsOptions,
): CommunityDocument[] {
  const priorBySlug = new Map(
    options.priorGeneratedCommunities.map((community) => [community.slug, community] as const),
  );

  return communities.map((community) => {
    const priorCommunity = priorBySlug.get(community.slug);
    const createdAt = priorCommunity?.createdAt ?? options.today;
    const summary = priorCommunity?.summary;
    const title = community.title;

    return {
      slug: community.slug,
      title,
      level: community.level,
      members: community.members,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(summary === undefined ? {} : { summary }),
      createdAt,
      updatedAt: options.today,
      content: renderCommunityDocument({
        title,
        members: community.members,
        level: community.level,
        ...(community.parent === undefined ? {} : { parent: community.parent }),
        ...(community.children === undefined ? {} : { children: community.children }),
        ...(summary === undefined ? {} : { summary }),
        createdAt,
        updatedAt: options.today,
      }),
    };
  });
}

export function generateCommunityFiles(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  documents: CommunityDocument[],
  priorGeneratedCommunities: ExistingGeneratedCommunity[],
  onWrite?: () => void,
): boolean {
  let wroteFiles = false;

  for (const community of priorGeneratedCommunities) {
    const communityPath = kb.communityPath(community.slug);
    if (!kb.storagePort.existsSync(communityPath)) {
      continue;
    }

    unlinkIfExists(communityPath);
    mutation.queueManifestAuthorityDelta(captureRemovedCommunityManifestDelta(community.slug));
    onWrite?.();
    wroteFiles = true;
  }

  for (const document of documents) {
    writeFileAtomic(kb, kb.communityPath(document.slug), document.content);
    mutation.queueManifestAuthorityDelta(captureCommunityManifestDelta(document.slug, document.content));
    onWrite?.();
    wroteFiles = true;
  }

  return wroteFiles;
}
