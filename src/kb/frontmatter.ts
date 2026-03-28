import { basename } from 'node:path';
import yaml from 'yaml';
import { identPattern, isRecord, isStringArray } from '../shared/mcp-utils.js';
import type { KbNoteFrontmatter, KbNoteIdentity } from './types.js';
import { NOTE_SLUG_PATTERN, assertNonEmptyText } from './validation.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Non-capturing frontmatter regex for stripping (no capture group, unlike FRONTMATTER_PATTERN). */
export const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/;
const TOP_LEVEL_TITLE = /^# .+(?:\r?\n){1,2}/;

export function extractBody(content: string): string {
  return content
    .replace(FRONTMATTER_BLOCK, '')
    .replace(TOP_LEVEL_TITLE, '')
    .trim();
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
  const parsed = yaml.parse(extractFrontmatterBlock(content)) as unknown;
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

function normalizeOptionalMutationSeqAtPromote(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('mutationSeqAtPromote must be a positive integer');
  }
  return value;
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

function normalizePrincipleList(value: unknown): string[] {
  return normalizeStringList(value, 'principles').map(normalizePrincipleReference);
}

export function parseFrontmatter(content: string): KbNoteFrontmatter {
  const record = parseFrontmatterRecord(content);
  const mutationSeqAtPromote = normalizeOptionalMutationSeqAtPromote(record.mutationSeqAtPromote);
  return {
    tags: normalizeStringList(record.tags, 'tags'),
    principles: normalizePrincipleList(record.principles),
    source: normalizeStringList(record.source, 'source'),
    createdAt: assertNonEmptyText(record.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(record.updatedAt, 'updatedAt'),
    ...(mutationSeqAtPromote === undefined ? {} : { mutationSeqAtPromote }),
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
  const serialized = yaml.stringify({
    source: fields.source,
    owner: fields.owner,
  }, {
    lineWidth: 0,
  }).trimEnd();

  return `---\n${serialized}\n---`;
}

export function serializeFrontmatter(meta: KbNoteFrontmatter): string {
  const mutationSeqAtPromote = normalizeOptionalMutationSeqAtPromote(meta.mutationSeqAtPromote);
  const serialized = yaml.stringify({
    tags: normalizeStringList(meta.tags, 'tags'),
    principles: normalizePrincipleList(meta.principles),
    source: normalizeStringList(meta.source, 'source'),
    createdAt: assertNonEmptyText(meta.createdAt, 'createdAt'),
    updatedAt: assertNonEmptyText(meta.updatedAt, 'updatedAt'),
    ...(mutationSeqAtPromote === undefined ? {} : { mutationSeqAtPromote }),
  }, {
    lineWidth: 0,
  }).trimEnd();

  return `---\n${serialized}\n---\n`;
}

export function replaceFrontmatter(content: string, meta: KbNoteFrontmatter): string {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new Error('Missing YAML frontmatter');
  }
  return `${serializeFrontmatter(meta)}${content.slice(match[0].length)}`;
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

export function serializeNote(meta: KbNoteFrontmatter, title: string, body: string): string {
  const heading = `# ${assertNonEmptyText(title, 'title')}`;
  const frontmatter = serializeFrontmatter(meta);
  const normalizedBody = body.trim();

  if (!normalizedBody) {
    return `${frontmatter}${heading}\n`;
  }

  return `${frontmatter}${heading}\n\n${normalizedBody}\n`;
}
