import { basename } from 'node:path';
import yaml from 'yaml';
import { isRecord, isStringArray } from '../shared/mcp-utils.js';
import type { KbNoteFrontmatter, KbNoteIdentity } from './types.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const NOTE_NAME_PATTERN = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

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

function normalizeNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a string array`);
  }

  return value.map((entry) => normalizeNonEmptyString(entry, field));
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
  return {
    tags: normalizeStringList(record.tags, 'tags'),
    principles: normalizePrincipleList(record.principles),
    source: normalizeStringList(record.source, 'source'),
    createdAt: normalizeNonEmptyString(record.createdAt, 'createdAt'),
    updatedAt: normalizeNonEmptyString(record.updatedAt, 'updatedAt'),
  };
}

export function parseMemoFrontmatter(content: string): { source: string[] } {
  const record = parseFrontmatterRecord(content);
  const { source } = record;

  if (typeof source === 'string') {
    return { source: [normalizeNonEmptyString(source, 'source')] };
  }
  if (isStringArray(source) && source.length > 0) {
    return { source: source.map((entry) => normalizeNonEmptyString(entry, 'source')) };
  }

  throw new Error('Memo frontmatter must include source as a string or non-empty string array');
}

export function serializeFrontmatter(meta: KbNoteFrontmatter): string {
  const serialized = yaml.stringify({
    tags: normalizeStringList(meta.tags, 'tags'),
    principles: normalizePrincipleList(meta.principles),
    source: normalizeStringList(meta.source, 'source'),
    createdAt: normalizeNonEmptyString(meta.createdAt, 'createdAt'),
    updatedAt: normalizeNonEmptyString(meta.updatedAt, 'updatedAt'),
  }, {
    lineWidth: 0,
  }).trimEnd();

  return `---\n${serialized}\n---\n`;
}

export function extractTitle(content: string): string {
  const title = content.match(/^# (.+)$/m)?.[1];
  if (!title) {
    throw new Error('KB note is missing a top-level title');
  }
  return normalizeNonEmptyString(title, 'title');
}

export function deriveNoteIdentity(pathOrName: string): KbNoteIdentity {
  const filename = basename(pathOrName);
  const note = filename.endsWith('.md') ? filename.slice(0, -3) : filename;

  if (!NOTE_NAME_PATTERN.test(note)) {
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
  const heading = `# ${normalizeNonEmptyString(title, 'title')}`;
  const frontmatter = serializeFrontmatter(meta);
  const normalizedBody = body.trim();

  if (!normalizedBody) {
    return `${frontmatter}${heading}\n`;
  }

  return `${frontmatter}${heading}\n\n${normalizedBody}\n`;
}
