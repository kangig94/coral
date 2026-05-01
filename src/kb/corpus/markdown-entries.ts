import { isNoEntryError } from '../../infra/fs-errors.js';
import type { StoragePort } from '../../runtime/ports.js';
import { compareLocale } from '../validation.js';

export function sortedMarkdownEntries(storage: Pick<StoragePort, 'readdirSync'>, dirPath: string): string[] {
  try {
    return storage
      .readdirSync(dirPath)
      .filter((entry) => entry.endsWith('.md'))
      .sort(compareLocale);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}
