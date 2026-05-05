import { isNoEntryError } from '../../infra/fs-errors.js';
import type { StoragePort } from '../../infra/port-types.js';
import { compareLocale } from '../validation.js';

export function sortedMarkdownEntries(storage: Pick<StoragePort, 'readdirSync'>, dirPath: string): string[] {
  try {
    const entries: string[] = [];
    for (const entry of storage.readdirSync(dirPath)) {
      if (entry.endsWith('.md')) {
        entries.push(entry);
      }
    }
    return entries.sort(compareLocale);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}
