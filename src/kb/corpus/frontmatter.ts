import { basename } from 'node:path';
import yaml from 'yaml';
import { errorMessage } from '../../infra/error-format.js';
import { identPattern } from '../../infra/identifiers.js';
import { isRecord, isStringArray } from '../../infra/json.js';
import {
  entryIdToVaultLink,
  parseKbEntryId,
  vaultLinkToEntryId,
  type CommunityFrontmatter,
  type KbEntryId,
  type KbNoteFrontmatter,
  type KbNoteIdentity,
  type KbSourceFrontmatter,
  type KbWikiFrontmatter,
} from '../entry-types.js';
import {
  NOTE_SLUG_PATTERN,
  assertNonEmptyText,
  compareLocale,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from '../validation.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export const FRONTMATTER_MAX_BYTES = 64 * 1024;

/** Non-capturing frontmatter regex for stripping (no capture group, unlike FRONTMATTER_PATTERN). */
export const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/;
const TOP_LEVEL_TITLE = /^# .+(?:\r?\n){1,2}/;

export function extractBody(content: string): string {
  return content.replace(FRONTMATTER_BLOCK, '').replace(TOP_LEVEL_TITLE, '').trim();
}

export function extractPrincipleStatement(content: string): string {
  const withoutFrontmatter = content.replace(FRONTMATTER_BLOCK, '').trim();
  if (!withoutFrontmatter) {
    throw new Error('KB principle is missing a statement');
  }
  return withoutFrontmatter.replace(/\s+/g, ' ');
}

function extractFrontmatterBlock(content: string): string {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new Error('Missing YAML frontmatter');
  }
  const rawBlock = match[1] ?? '';
  const rawBlockBytes = Buffer.byteLength(rawBlock, 'utf-8');
  if (rawBlockBytes > FRONTMATTER_MAX_BYTES) {
    throw new Error(
      `Frontmatter block exceeds maximum parse size (${rawBlockBytes} bytes > ${FRONTMATTER_MAX_BYTES} bytes)`,
    );
  }
  return rawBlock;
}

function parseFrontmatterRecord(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = yaml.parse(extractFrontmatterBlock(content)) as unknown;
  } catch (error: unknown) {
    const message = errorMessage(error);
    throw new Error(`YAML parse error: ${message}`, {
      ...(error instanceof Error ? { cause: error } : {}),
    });
  }
  if (parsed === null) {
    return {};
  }
  if (!isRecord(parsed)) {
    throw new Error('Frontmatter must be a mapping');
  }
  return parsed;
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a string array`);
  }

  const normalized: string[] = [];
  for (const entry of value) {
    normalized.push(assertNonEmptyText(entry, field));
  }
  return normalized;
}

function normalizeOptionalEntrySeq(value: unknown): number | undefined {
  return value === undefined ? undefined : parsePositiveInteger(value, 'entrySeq');
}

function normalizeOptionalNonEmptyText(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return assertNonEmptyText(value, field);
}

export function normalizeCommunityParent(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = parseKbEntryId(assertNonEmptyText(value, 'parent'));
  if (normalized === null || !normalized.startsWith('community:')) {
    throw new Error('parent must be a community entry ID');
  }

  return normalized;
}

export function normalizeCommunityChildren(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const children: string[] = [];
  for (const entry of normalizeStringList(value, 'children')) {
    const normalized = parseKbEntryId(entry);
    if (normalized === null || !normalized.startsWith('community:')) {
      throw new Error('children must contain community entry IDs');
    }

    children.push(normalized);
  }
  return children;
}

export function normalizePrincipleReference(value: string): string {
  const trimmed = value.trim();
  const wrapped = trimmed.match(/^\[\[(.+)\]\]$/)?.[1];
  const normalized = (wrapped ?? trimmed).trim();
  if (!normalized) {
    throw new Error('Principle references must be non-empty');
  }
  return normalized;
}

function normalizePrincipleReferenceList(value: unknown, field: string): string[] {
  const principles: string[] = [];
  for (const entry of normalizeStringList(value, field)) {
    principles.push(normalizePrincipleReference(entry));
  }
  return principles;
}

function normalizePrincipleList(value: unknown): string[] {
  return normalizePrincipleReferenceList(value, 'principles');
}

function normalizeEntryIdList(value: unknown, field: string): KbEntryId[] {
  const normalizedEntries: KbEntryId[] = [];
  for (const entry of normalizeStringList(value, field)) {
    const normalized = parseKbEntryId(entry);
    if (normalized === null) {
      throw new Error(`${field} must contain KB entry IDs`);
    }
    normalizedEntries.push(normalized);
  }
  return normalizedEntries;
}

function normalizeRelatedList(value: unknown): KbEntryId[] {
  if (value === undefined) {
    return [];
  }

  const related: KbEntryId[] = [];
  for (const entry of normalizeStringList(value, 'related')) {
    const normalized = vaultLinkToEntryId(entry);
    if (normalized === null) {
      throw new Error('related must contain vault-relative wikilinks');
    }
    related.push(normalized);
  }
  return related;
}

function serializeFrontmatterRecord(record: Record<string, unknown>): string {
  const serialized = yaml
    .stringify(record, {
      lineWidth: 0,
    })
    .trimEnd();

  return `---\n${serialized}\n---\n`;
}

function replaceFrontmatterBlock(content: string, frontmatter: string): string {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new Error('Missing YAML frontmatter');
  }
  return `${frontmatter}${content.slice(match[0].length)}`;
}

export function parseFrontmatter(content: string): KbNoteFrontmatter {
  const record = parseFrontmatterRecord(content);
  const entrySeq = normalizeOptionalEntrySeq(record.entrySeq);
  const related = normalizeRelatedList(record.related);
  const inputFingerprint = normalizeOptionalNonEmptyText(record.inputFingerprint, 'inputFingerprint');
  return {
    tags: normalizeStringList(record.tags, 'tags'),
    principles: normalizePrincipleList(record.principles),
    source: normalizeStringList(record.source, 'source'),
    createdAt: assertNonEmptyText(record.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(record.updatedAt, 'updatedAt'),
    related,
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    ...(entrySeq === undefined ? {} : { entrySeq }),
  };
}

export function parseSourceFrontmatter(content: string): KbSourceFrontmatter {
  const record = parseFrontmatterRecord(content);
  const url = normalizeOptionalNonEmptyText(record.url, 'url');
  const entrySeq = normalizeOptionalEntrySeq(record.entrySeq);
  const related = normalizeRelatedList(record.related);
  const inputFingerprint = normalizeOptionalNonEmptyText(record.inputFingerprint, 'inputFingerprint');

  return {
    title: assertNonEmptyText(record.title, 'title'),
    type: assertNonEmptyText(record.type, 'type'),
    tags: normalizeStringList(record.tags, 'tags'),
    ...(url === undefined ? {} : { url }),
    importedAt: assertNonEmptyText(record.importedAt, 'importedAt'),
    related,
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    ...(entrySeq === undefined ? {} : { entrySeq }),
  };
}

export function parseCommunityFrontmatter(content: string): CommunityFrontmatter {
  const record = parseFrontmatterRecord(content);
  const level = parseNonNegativeInteger(record.level ?? 0, 'level');
  const parent = normalizeCommunityParent(record.parent);
  const children = normalizeCommunityChildren(record.children);
  const summaryInputFingerprint = normalizeOptionalNonEmptyText(
    record.summaryInputFingerprint,
    'summaryInputFingerprint',
  );
  return {
    createdAt: assertNonEmptyText(record.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(record.updatedAt, 'updatedAt'),
    level,
    ...(parent === undefined ? {} : { parent }),
    ...(children === undefined ? {} : { children }),
    ...(summaryInputFingerprint === undefined ? {} : { summaryInputFingerprint }),
  };
}

export function parseWikiFrontmatter(content: string): KbWikiFrontmatter {
  const record = parseFrontmatterRecord(content);
  return {
    tags: normalizeStringList(record.tags, 'tags'),
    createdAt: assertNonEmptyText(record.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(record.updatedAt, 'updatedAt'),
  };
}

export function parseMemoFrontmatter(content: string): { source: string[]; owner?: string } {
  const record = parseFrontmatterRecord(content);
  const { source, owner } = record;

  let parsedSource: string[];
  if (typeof source === 'string') {
    parsedSource = [assertNonEmptyText(source, 'source')];
  } else if (isStringArray(source) && source.length > 0) {
    parsedSource = [];
    for (const entry of source) {
      parsedSource.push(assertNonEmptyText(entry, 'source'));
    }
  } else {
    throw new Error('Memo frontmatter must include source as a string or non-empty string array');
  }

  if (owner === undefined) {
    return { source: parsedSource };
  }

  if (typeof owner !== 'string' || !identPattern.test(owner)) {
    throw new Error('Memo frontmatter owner must be a non-empty token-safe identifier');
  }

  return { source: parsedSource, owner };
}

/** Serialize memo frontmatter (source + owner) using YAML output for safety. */
export function serializeMemoFrontmatter(fields: { source: string; owner: string }): string {
  const serialized = yaml
    .stringify(
      {
        source: fields.source,
        owner: fields.owner,
      },
      {
        lineWidth: 0,
      },
    )
    .trimEnd();

  return `---\n${serialized}\n---`;
}

export function serializeFrontmatter(meta: KbNoteFrontmatter): string {
  const entrySeq = normalizeOptionalEntrySeq(meta.entrySeq);
  const related = normalizeEntryIdList(meta.related ?? [], 'related');
  const relatedLinks: string[] = [];
  for (const entry of related) {
    relatedLinks.push(entryIdToVaultLink(entry));
  }
  return serializeFrontmatterRecord({
    tags: normalizeStringList(meta.tags, 'tags'),
    principles: normalizePrincipleList(meta.principles),
    source: normalizeStringList(meta.source, 'source'),
    createdAt: assertNonEmptyText(meta.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(meta.updatedAt, 'updatedAt'),
    ...(meta.inputFingerprint === undefined
      ? {}
      : { inputFingerprint: assertNonEmptyText(meta.inputFingerprint, 'inputFingerprint') }),
    ...(entrySeq === undefined ? {} : { entrySeq }),
    ...(relatedLinks.length === 0 ? {} : { related: relatedLinks }),
  });
}

export function serializeSourceFrontmatter(meta: KbSourceFrontmatter): string {
  const url = normalizeOptionalNonEmptyText(meta.url, 'url');
  const entrySeq = normalizeOptionalEntrySeq(meta.entrySeq);
  const related = normalizeEntryIdList(meta.related ?? [], 'related');
  const relatedLinks: string[] = [];
  for (const entry of related) {
    relatedLinks.push(entryIdToVaultLink(entry));
  }
  return serializeFrontmatterRecord({
    title: assertNonEmptyText(meta.title, 'title'),
    type: assertNonEmptyText(meta.type, 'type'),
    tags: normalizeStringList(meta.tags, 'tags'),
    ...(url === undefined ? {} : { url }),
    importedAt: assertNonEmptyText(meta.importedAt, 'importedAt'),
    ...(meta.inputFingerprint === undefined
      ? {}
      : { inputFingerprint: assertNonEmptyText(meta.inputFingerprint, 'inputFingerprint') }),
    ...(entrySeq === undefined ? {} : { entrySeq }),
    ...(relatedLinks.length === 0 ? {} : { related: relatedLinks }),
  });
}

export function serializeCommunityFrontmatter(
  meta: Omit<CommunityFrontmatter, 'level'> & { level?: number; summaryInputFingerprint?: string },
): string {
  const level = parseNonNegativeInteger(meta.level ?? 0, 'level');
  const parent = normalizeCommunityParent(meta.parent);
  const children = normalizeCommunityChildren(meta.children);
  return serializeFrontmatterRecord({
    createdAt: assertNonEmptyText(meta.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(meta.updatedAt, 'updatedAt'),
    level,
    ...(meta.summaryInputFingerprint === undefined
      ? {}
      : { summaryInputFingerprint: assertNonEmptyText(meta.summaryInputFingerprint, 'summaryInputFingerprint') }),
    ...(parent === undefined ? {} : { parent }),
    ...(children === undefined ? {} : { children }),
  });
}

export function serializeWikiFrontmatter(meta: KbWikiFrontmatter): string {
  return serializeFrontmatterRecord({
    tags: normalizeStringList(meta.tags, 'tags'),
    createdAt: assertNonEmptyText(meta.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(meta.updatedAt, 'updatedAt'),
  });
}

export function replaceFrontmatter(content: string, meta: KbNoteFrontmatter): string {
  return replaceFrontmatterBlock(content, serializeFrontmatter(meta));
}

export function replaceSourceFrontmatter(content: string, meta: KbSourceFrontmatter): string {
  return replaceFrontmatterBlock(content, serializeSourceFrontmatter(meta));
}

export function replaceCommunityFrontmatter(content: string, meta: CommunityFrontmatter): string {
  return replaceFrontmatterBlock(content, serializeCommunityFrontmatter(meta));
}

export function extractTitle(content: string): string {
  const title = content.match(/^# (.+)$/m)?.[1];
  if (!title) {
    throw new Error('KB note is missing a top-level title');
  }
  return assertNonEmptyText(title, 'title');
}

export function deriveNoteIdentity(pathOrName: string): KbNoteIdentity {
  const filename = basename(pathOrName);
  const note = filename.endsWith('.md') ? filename.slice(0, -3) : filename;

  if (!NOTE_SLUG_PATTERN.test(note)) {
    throw new Error(`Invalid KB note name: ${note}`);
  }

  const [domain, ...topicParts] = note.split('-');
  if (!domain || topicParts.length === 0) {
    throw new Error(`KB note name must include both domain and topic: ${note}`);
  }

  return {
    note,
    domain,
    topic: topicParts.join('-'),
  };
}

export function parseMembersFromBody(body: string): string[] {
  const membersMatch = body.match(/## Members\s*\n([\s\S]*?)(?:\n##|\n*$)/);
  if (!membersMatch) return [];
  const members: string[] = [];
  for (const line of membersMatch[1].split('\n')) {
    const member = line.replace(/^-\s*#?/, '').trim();
    if (member.length > 0) {
      members.push(member);
    }
  }
  return members.sort(compareLocale);
}

export function parseSummaryFromBody(body: string): string | undefined {
  const summaryMatch = body.match(/## Summary\s*\n\n([\s\S]*?)(?:\n\n## |\n*$)/);
  if (!summaryMatch) return undefined;
  const text = summaryMatch[1].trim();
  return text || undefined;
}

export type WikiBodySections = {
  understanding: string;
  knowledge: string;
};

const WIKI_BODY_HEADERS = ['Understanding', 'Knowledge'] as const;
const WIKI_BODY_HEADER_PATTERN = /^## (Understanding|Knowledge)[ \t]*(?:\r?\n|$)/gm;

export function parseWikiBody(body: string): WikiBodySections {
  const matches = Array.from(body.matchAll(WIKI_BODY_HEADER_PATTERN));
  const byHeader = new Map<string, RegExpMatchArray>();

  for (const match of matches) {
    const header = match[1];
    if (byHeader.has(header)) {
      throw new Error(`Wiki body contains duplicate ## ${header} header`);
    }
    byHeader.set(header, match);
  }

  for (const header of WIKI_BODY_HEADERS) {
    if (!byHeader.has(header)) {
      throw new Error(`Wiki body is missing ## ${header} header`);
    }
  }

  const ordered: RegExpMatchArray[] = [];
  for (const header of WIKI_BODY_HEADERS) {
    ordered.push(byHeader.get(header) as RegExpMatchArray);
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const match = ordered[index];
    if ((match.index ?? -1) !== matches[index]?.index) {
      throw new Error('Wiki body headers must appear in Understanding, Knowledge order');
    }
  }

  const firstHeaderIndex = ordered[0].index ?? 0;
  if (body.slice(0, firstHeaderIndex).trim()) {
    throw new Error('Wiki body must begin with ## Understanding');
  }

  const sectionContent = (index: number): string => {
    const match = ordered[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = ordered[index + 1]?.index ?? body.length;
    return body.slice(start, end).trim();
  };

  return {
    understanding: sectionContent(0),
    knowledge: sectionContent(1),
  };
}

/**
 * One Knowledge entry: a top-level `- [[link]]` line plus any indented
 * sub-bullet lines that follow it (each carrying date + evidence text).
 * Knowledge owns its evidence physically — removing the block removes
 * its evidence in the same write, no separate sync.
 */
export type KnowledgeBlock = {
  entryId: KbEntryId;
  /** Original top-level line text, e.g. `- [[notes/foo]]`. */
  header: string;
  /** Indented sub-bullet lines as written, in order. Each entry is a single line. */
  evidence: string[];
};

const KNOWLEDGE_TOP_LEVEL_PATTERN = /^-\s+(\[\[(?:notes|sources|communities|wiki)\/[^[\]/]+\]\])\s*$/;
const KNOWLEDGE_SUB_BULLET_PATTERN = /^[ \t]+-\s+\S/;

export function parseKnowledgeBlocks(knowledge: string): KnowledgeBlock[] {
  const blocks: KnowledgeBlock[] = [];
  const lines = knowledge.split(/\r?\n/u);
  let current: KnowledgeBlock | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/u, '');
    if (line.length === 0) {
      continue;
    }
    const headerMatch = line.match(KNOWLEDGE_TOP_LEVEL_PATTERN);
    if (headerMatch !== null) {
      const entryId = vaultLinkToEntryId(headerMatch[1]);
      if (entryId === null) {
        continue;
      }
      current = { entryId, header: line.trimStart(), evidence: [] };
      blocks.push(current);
      continue;
    }
    if (KNOWLEDGE_SUB_BULLET_PATTERN.test(line) && current !== null) {
      current.evidence.push(line);
      continue;
    }
    // Unrecognized line under a block (e.g. malformed indentation or stray
    // text between blocks). Strict parser: skip silently — extractKnowledgeLinks
    // and serializeKnowledgeBlocks operate on the recognized structure only.
  }

  return blocks;
}

export function serializeKnowledgeBlocks(blocks: readonly KnowledgeBlock[]): string {
  const rendered: string[] = [];
  for (const block of blocks) {
    rendered.push(block.evidence.length === 0 ? block.header : `${block.header}\n${block.evidence.join('\n')}`);
  }
  return rendered.join('\n');
}

export function serializeNote(meta: KbNoteFrontmatter, title: string, body: string): string {
  const heading = `# ${assertNonEmptyText(title, 'title')}`;
  const frontmatter = serializeFrontmatter(meta);
  const normalizedBody = body.trim();

  if (!normalizedBody) {
    return `${frontmatter}${heading}\n`;
  }

  return `${frontmatter}${heading}\n\n${normalizedBody}\n`;
}

export function serializeWiki(meta: KbWikiFrontmatter, title: string, body: string): string {
  const heading = `# ${assertNonEmptyText(title, 'title')}`;
  const frontmatter = serializeWikiFrontmatter(meta);
  const normalizedBody = body.trim();
  parseWikiBody(normalizedBody);

  return `${frontmatter}${heading}\n\n${normalizedBody}\n`;
}
