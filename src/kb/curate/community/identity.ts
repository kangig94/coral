import { createHash } from 'node:crypto';

import { parseKbEntryId } from '../../entry-types.js';
import { compareLocale } from '../../validation.js';

export function uniqueSorted(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique.sort(compareLocale);
}

export function computeTextFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function communitySlugFromReference(reference: string): string {
  const parsed = parseKbEntryId(reference);
  if (parsed !== null && parsed.startsWith('community:')) {
    return parsed.slice('community:'.length);
  }

  return reference;
}
