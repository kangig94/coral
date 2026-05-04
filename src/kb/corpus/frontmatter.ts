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
  return match[1];
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

  return value.map((entry) => assertNonEmptyText(entry, field));
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

  return normalizeStringList(value, 'children').map((entry) => {
    const normalized = parseKbEntryId(entry);
    if (normalized === null || !normalized.startsWith('community:')) {
      throw new Error('children must contain community entry IDs');
    }

    return normalized;
  });
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
  return normalizeStringList(value, field).map(normalizePrincipleReference);
}

function normalizePrincipleList(value: unknown): string[] {
  return normalizePrincipleReferenceList(value, 'principles');
}

function normalizeEntryIdList(value: unknown, field: string): KbEntryId[] {
  return normalizeStringList(value, field).map((entry) => {
    const normalized = parseKbEntryId(entry);
    if (normalized === null) {
      throw new Error(`${field} must contain KB entry IDs`);
    }
    return normalized;
  });
}

function normalizeRelatedList(value: unknown): KbEntryId[] {
  if (value === undefined) {
    return [];
  }

  return normalizeStringList(value, 'related').map((entry) => {
    const normalized = vaultLinkToEntryId(entry);
    if (normalized === null) {
      throw new Error('related must contain vault-relative wikilinks');
    }
    return normalized;
  });
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
  return {
    tags: normalizeStringList(record.tags, 'tags'),
    principles: normalizePrincipleList(record.principles),
    source: normalizeStringList(record.source, 'source'),
    createdAt: assertNonEmptyText(record.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(record.updatedAt, 'updatedAt'),
    related,
    ...(entrySeq === undefined ? {} : { entrySeq }),
  };
}

export function parseSourceFrontmatter(content: string): KbSourceFrontmatter {
  const record = parseFrontmatterRecord(content);
  const url = normalizeOptionalNonEmptyText(record.url, 'url');
  const entrySeq = normalizeOptionalEntrySeq(record.entrySeq);
  const related = normalizeRelatedList(record.related);

  return {
    title: assertNonEmptyText(record.title, 'title'),
    type: assertNonEmptyText(record.type, 'type'),
    tags: normalizeStringList(record.tags, 'tags'),
    ...(url === undefined ? {} : { url }),
    importedAt: assertNonEmptyText(record.importedAt, 'importedAt'),
    related,
    ...(entrySeq === undefined ? {} : { entrySeq }),
  };
}

export function parseCommunityFrontmatter(content: string): CommunityFrontmatter {
  const record = parseFrontmatterRecord(content);
  const level = parseNonNegativeInteger(record.level ?? 0, 'level');
  const parent = normalizeCommunityParent(record.parent);
  const children = normalizeCommunityChildren(record.children);
  return {
    createdAt: assertNonEmptyText(record.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(record.updatedAt, 'updatedAt'),
    level,
    ...(parent === undefined ? {} : { parent }),
    ...(children === undefined ? {} : { children }),
  };
}

export function parseWikiFrontmatter(content: string): KbWikiFrontmatter {
  const record = parseFrontmatterRecord(content);
  const entrySeq = normalizeOptionalEntrySeq(record.entrySeq);
  const related = normalizeRelatedList(record.related);
  return {
    tags: normalizeStringList(record.tags, 'tags'),
    references_principles: normalizePrincipleReferenceList(record.references_principles, 'references_principles'),
    createdAt: assertNonEmptyText(record.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(record.updatedAt, 'updatedAt'),
    related,
    ...(entrySeq === undefined ? {} : { entrySeq }),
  };
}

export function parseMemoFrontmatter(content: string): { source: string[]; owner?: string } {
  const record = parseFrontmatterRecord(content);
  const { source, owner } = record;

  let parsedSource: string[];
  if (typeof source === 'string') {
    parsedSource = [assertNonEmptyText(source, 'source')];
  } else if (isStringArray(source) && source.length > 0) {
    parsedSource = source.map((entry) => assertNonEmptyText(entry, 'source'));
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
  return serializeFrontmatterRecord({
    tags: normalizeStringList(meta.tags, 'tags'),
    principles: normalizePrincipleList(meta.principles),
    source: normalizeStringList(meta.source, 'source'),
    createdAt: assertNonEmptyText(meta.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(meta.updatedAt, 'updatedAt'),
    ...(entrySeq === undefined ? {} : { entrySeq }),
    ...(related.length === 0 ? {} : { related: related.map((entry) => entryIdToVaultLink(entry)) }),
  });
}

export function serializeSourceFrontmatter(meta: KbSourceFrontmatter): string {
  const url = normalizeOptionalNonEmptyText(meta.url, 'url');
  const entrySeq = normalizeOptionalEntrySeq(meta.entrySeq);
  const related = normalizeEntryIdList(meta.related ?? [], 'related');
  return serializeFrontmatterRecord({
    title: assertNonEmptyText(meta.title, 'title'),
    type: assertNonEmptyText(meta.type, 'type'),
    tags: normalizeStringList(meta.tags, 'tags'),
    ...(url === undefined ? {} : { url }),
    importedAt: assertNonEmptyText(meta.importedAt, 'importedAt'),
    ...(entrySeq === undefined ? {} : { entrySeq }),
    ...(related.length === 0 ? {} : { related: related.map((entry) => entryIdToVaultLink(entry)) }),
  });
}

export function serializeCommunityFrontmatter(meta: Omit<CommunityFrontmatter, 'level'> & { level?: number }): string {
  const level = parseNonNegativeInteger(meta.level ?? 0, 'level');
  const parent = normalizeCommunityParent(meta.parent);
  const children = normalizeCommunityChildren(meta.children);
  return serializeFrontmatterRecord({
    createdAt: assertNonEmptyText(meta.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(meta.updatedAt, 'updatedAt'),
    level,
    ...(parent === undefined ? {} : { parent }),
    ...(children === undefined ? {} : { children }),
  });
}

export function serializeWikiFrontmatter(meta: KbWikiFrontmatter): string {
  const entrySeq = normalizeOptionalEntrySeq(meta.entrySeq);
  const related = normalizeEntryIdList(meta.related ?? [], 'related');
  return serializeFrontmatterRecord({
    tags: normalizeStringList(meta.tags, 'tags'),
    references_principles: normalizePrincipleReferenceList(meta.references_principles, 'references_principles'),
    createdAt: assertNonEmptyText(meta.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(meta.updatedAt, 'updatedAt'),
    ...(entrySeq === undefined ? {} : { entrySeq }),
    ...(related.length === 0 ? {} : { related: related.map((entry) => entryIdToVaultLink(entry)) }),
  });
}

export function replaceFrontmatter(content: string, meta: KbNoteFrontmatter): string {
  return replaceFrontmatterBlock(content, serializeFrontmatter(meta));
}

export function replaceSourceFrontmatter(content: string, meta: KbSourceFrontmatter): string {
  return replaceFrontmatterBlock(content, serializeSourceFrontmatter(meta));
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
  return membersMatch[1]
    .split('\n')
    .map((line) => line.replace(/^-\s*#?/, '').trim())
    .filter(Boolean)
    .sort(compareLocale);
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
  evidence: string;
};

const WIKI_BODY_HEADERS = ['Understanding', 'Knowledge', 'Evidence'] as const;
const WIKI_BODY_HEADER_PATTERN = /^## (Understanding|Knowledge|Evidence)[ \t]*(?:\r?\n|$)/gm;

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

  const ordered = WIKI_BODY_HEADERS.map((header) => byHeader.get(header) as RegExpMatchArray);
  if (!ordered.every((match, index) => (match.index ?? -1) === matches[index]?.index)) {
    throw new Error('Wiki body headers must appear in Understanding, Knowledge, Evidence order');
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
    evidence: sectionContent(2),
  };
}

export type EvidenceRow = {
  date: string;
  slug: string;
  summary: string;
};

// `{ISO-8601 date} {slug} → {summary}` — slug stored as plain text so Knowledge
// (canonical [[wikilinks]]) and Evidence (audit trail) cannot drift.
const EVIDENCE_ROW_PATTERN = /^-\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.Z+-]+)?)\s+(\S+)\s+(?:→|->)\s+(.+)$/;

export function parseEvidenceRow(line: string): EvidenceRow | null {
  const match = line.trim().match(EVIDENCE_ROW_PATTERN);
  if (match === null) {
    return null;
  }

  return {
    date: match[1],
    slug: match[2],
    summary: match[3].trim(),
  };
}

export function serializeEvidenceRow(row: EvidenceRow): string {
  return `- ${row.date} ${row.slug} → ${row.summary}`.trim();
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
