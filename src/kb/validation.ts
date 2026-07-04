import { stripMdExt } from './paths.js';

/** Lowercase-only slug (e.g. domain, memo topic). */
const LOWERCASE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mixed-case slug for KB filenames that embed code identifiers (e.g. rendering-efficiency-CuMem). */
export const NOTE_SLUG_PATTERN = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

export function assertNonEmptyText(value: unknown, label: string): string {
  const normalized = assertString(value, label).trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

/** Assert lowercase-only slug (for domain, memo topic). */
export function assertSlug(value: unknown, label: string): string {
  const normalized = assertNonEmptyText(value, label);
  if (!LOWERCASE_SLUG_PATTERN.test(normalized)) {
    throw new Error(`${label} must be kebab-case alphanumeric (e.g. my-topic)`);
  }
  return normalized;
}

export function compareLocale(left: string, right: string): number {
  return left.localeCompare(right);
}

/** Assert mixed-case slug (for note names, promote topic, principle slugs). */
export function assertNoteSlug(value: unknown, label: string): string {
  const trimmed = assertNonEmptyText(value, label);
  const normalized = stripMdExt(trimmed);
  if (!NOTE_SLUG_PATTERN.test(normalized)) {
    throw new Error(`${label} must be kebab-case alphanumeric (e.g. my-topic)`);
  }
  return normalized;
}

export function assertSourceSlug(value: unknown, label: string): string {
  return assertNoteSlug(value, label);
}

export function assertWikiSlug(value: unknown, label: string): string {
  return assertNoteSlug(value, label);
}

/** Strip markdown code fences (```json, ```markdown, etc.) wrapping raw LLM output. */
export function stripMarkdownCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

export function parseOptionalTrimmedString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = assertString(value, label).trim();
  return normalized || undefined;
}

export function assertCommunitySlug(value: unknown, label: string): string {
  return assertNoteSlug(value, label);
}
