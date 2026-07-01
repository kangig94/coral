import { serializeCommunityFrontmatter } from '../../corpus/frontmatter.js';
import type { CommunityDocument, DetectedCommunity, ExistingGeneratedCommunity } from './contracts.js';

type BuildCommunityDocumentsOptions = {
  priorGeneratedCommunities: ExistingGeneratedCommunity[];
  today: string;
};

function renderMembersSection(members: string[]): string {
  const lines = ['## Members', ''];
  for (const member of members) {
    lines.push(`- #${member}`);
  }
  return lines.join('\n');
}

function renderChildrenSection(children: string[]): string {
  const lines = ['## Children', ''];
  for (const child of children) {
    lines.push(`- ${child}`);
  }
  return lines.join('\n');
}

export function renderCommunityDocument(document: {
  title: string;
  members: string[];
  level?: number;
  parent?: string;
  children?: string[];
  summary?: string;
  summaryInputFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}): string {
  const frontmatter = serializeCommunityFrontmatter({
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    level: document.level,
    ...(document.summaryInputFingerprint === undefined
      ? {}
      : { summaryInputFingerprint: document.summaryInputFingerprint }),
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
  const priorBySlug = new Map<string, ExistingGeneratedCommunity>();
  for (const community of options.priorGeneratedCommunities) {
    priorBySlug.set(community.slug, community);
  }

  const documents: CommunityDocument[] = [];
  for (const community of communities) {
    const priorCommunity = priorBySlug.get(community.slug);
    const createdAt = priorCommunity?.createdAt ?? options.today;
    const summary = priorCommunity?.summary;
    const summaryInputFingerprint = priorCommunity?.summaryInputFingerprint;
    const title = community.title;

    const document: CommunityDocument = {
      slug: community.slug,
      title,
      level: community.level,
      members: community.members,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(summary === undefined ? {} : { summary }),
      ...(summaryInputFingerprint === undefined ? {} : { summaryInputFingerprint }),
      createdAt,
      updatedAt: options.today,
      content: renderCommunityDocument({
        title,
        members: community.members,
        level: community.level,
        ...(community.parent === undefined ? {} : { parent: community.parent }),
        ...(community.children === undefined ? {} : { children: community.children }),
        ...(summary === undefined ? {} : { summary }),
        ...(summaryInputFingerprint === undefined ? {} : { summaryInputFingerprint }),
        createdAt,
        updatedAt: options.today,
      }),
    };
    documents.push(document);
  }
  return documents;
}
