import { setImmediate as waitImmediate } from 'node:timers/promises';

import { insertMultiple } from '@orama/orama';

import type { KbOramaDocument } from './document-builder.js';
import type { KbOramaDb } from './schema.js';

export const ORAMA_FULL_INSTALL_INSERT_BATCH_SIZE = 500;

export async function insertOramaDocumentsCooperatively(
  db: KbOramaDb,
  documents: readonly KbOramaDocument[],
  options: { batchSize?: number } = {},
): Promise<void> {
  if (documents.length === 0) {
    return;
  }
  const batchSize =
    Number.isSafeInteger(options.batchSize) && options.batchSize !== undefined && options.batchSize > 0
      ? options.batchSize
      : ORAMA_FULL_INSTALL_INSERT_BATCH_SIZE;

  for (let index = 0; index < documents.length; index += batchSize) {
    await insertMultiple(db, [...documents.slice(index, index + batchSize)]);
    if (index + batchSize < documents.length) {
      await waitImmediate();
    }
  }
}
