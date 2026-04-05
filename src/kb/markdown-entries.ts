import { readdirSync } from 'node:fs';
import { isNoEntryError } from '../shared/mcp-utils.js';
import { compareLocale } from './validation.js';

export function sortedMarkdownEntries(dirPath: string): string[] {
  try {
    return readdirSync(dirPath)
      .filter((entry) => entry.endsWith('.md'))
      .sort(compareLocale);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}
