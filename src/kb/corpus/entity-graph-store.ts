import { readFileSync } from 'node:fs';

import { coordinatorLog } from '../../infra/coordinator-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord } from '../../infra/json.js';
import type { EntityGraph } from '../entry-types.js';
import { parseEntityMetaMap, parseEntityRelationships, writeJsonAtomic } from './index-store.js';

export function parseEntityGraph(value: unknown): EntityGraph {
  if (!isRecord(value) || !('entityMeta' in value) || !('relationships' in value)) {
    throw new Error('Invalid KB entity graph');
  }

  return {
    entityMeta: parseEntityMetaMap(value.entityMeta),
    relationships: parseEntityRelationships(value.relationships),
  };
}

export function readEntityGraphFile(graphPath: string): EntityGraph | null {
  try {
    const raw = readFileSync(graphPath, 'utf-8');
    if (raw.includes('<<<<<<<')) {
      throw new Error('Merge conflict markers detected.');
    }

    return parseEntityGraph(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }

    coordinatorLog.warn(
      `KB entity graph is unavailable; graph and community-derived features are disabled: ${errorMessage(error)}`,
    );
    return null;
  }
}

export function writeEntityGraphFile(graphPath: string, graph: EntityGraph): {
  normalized: EntityGraph;
  raw: string;
} {
  const normalized = parseEntityGraph(graph);
  const raw = `${JSON.stringify(normalized, null, 2)}\n`;
  writeJsonAtomic(graphPath, normalized);
  return { normalized, raw };
}
