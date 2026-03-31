import { deriveNoteIdentity } from './frontmatter.js';
import type { KbIndex } from './types.js';
import { compareLocale } from './validation.js';

const PATTERN_SUFFIXES = new Set(['pattern', 'architecture', 'design', 'contract', 'strategy']);

export type TagCleanupResult = {
  globalReplacements: Map<string, string>;
  globalDeletions: Set<string>;
};

export function countTagSupport(index: KbIndex): Map<string, number> {
  const counts = new Map<string, number>();

  for (const note of Object.values(index.notes)) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return counts;
}

function matchesPatternSuffix(tag: string): boolean {
  const suffix = tag.slice(tag.lastIndexOf('-') + 1);
  return PATTERN_SUFFIXES.has(suffix);
}

export function cleanupTags(index: KbIndex, cohortNotes: string[]): TagCleanupResult {
  const tagSupport = countTagSupport(index);
  const cohortTags = new Set<string>();

  for (const note of cohortNotes) {
    const noteMeta = index.notes[note];
    if (noteMeta === undefined) {
      continue;
    }

    const domain = deriveNoteIdentity(note).domain;
    for (const tag of noteMeta.tags) {
      if (tag !== domain) {
        cohortTags.add(tag);
      }
    }
  }

  const globalReplacements = new Map<string, string>();
  const globalDeletions = new Set<string>();
  const sortedAllTags = [...tagSupport.keys()].sort(compareLocale);

  for (const singular of sortedAllTags) {
    const plural = `${singular}s`;
    if (!tagSupport.has(plural)) {
      continue;
    }

    const singularCount = tagSupport.get(singular) ?? 0;
    const pluralCount = tagSupport.get(plural) ?? 0;
    if (pluralCount > singularCount) {
      if (cohortTags.has(singular)) {
        globalReplacements.set(singular, plural);
      }
      continue;
    }

    if (cohortTags.has(plural)) {
      globalReplacements.set(plural, singular);
    }
  }

  for (const tag of [...cohortTags].sort(compareLocale)) {
    if (globalReplacements.has(tag)) {
      continue;
    }

    const support = tagSupport.get(tag) ?? 0;
    if (matchesPatternSuffix(tag) && support < 3) {
      globalDeletions.add(tag);
    }
    if (support === 1 && tag.split('-').length >= 3) {
      globalDeletions.add(tag);
    }
  }

  for (const tag of globalReplacements.keys()) {
    globalDeletions.delete(tag);
  }

  return {
    globalReplacements,
    globalDeletions,
  };
}
