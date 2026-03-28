import { stripMdExt } from './paths.js';

/** Lowercase-only slug (e.g. domain, memo topic). */
export const LOWERCASE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mixed-case slug for KB filenames that embed code identifiers (e.g. rendering-efficiency-CuMem). */
export const NOTE_SLUG_PATTERN = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

export function assertString(value: unknown, label: string): string {
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
    throw new Error(`${label} must be slug-safe`);
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
    throw new Error(`${label} must be slug-safe`);
  }
  return normalized;
}
