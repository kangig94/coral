import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord } from '../../infra/json.js';
import type { StoragePort } from '../../runtime/ports.js';
import type { EntityGraph } from '../entry-types.js';
import type { FileAtomicHost } from './file-atomic.js';
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

export function readEntityGraphFile(
  storage: Pick<StoragePort, 'readFileSync'>,
  graphPath: string,
): EntityGraph | null {
  try {
    const raw = storage.readFileSync(graphPath, 'utf-8');
    if (raw.includes('<<<<<<<')) {
      throw new Error('Merge conflict markers detected.');
    }

    return parseEntityGraph(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }

    backendLog.warn(
      `KB entity graph is unavailable; graph and community-derived features are disabled: ${errorMessage(error)}`,
    );
    return null;
  }
}

export function writeEntityGraphFile(
  host: FileAtomicHost,
  graphPath: string,
  graph: EntityGraph,
): {
  normalized: EntityGraph;
  raw: string;
} {
  const normalized = parseEntityGraph(graph);
  const raw = `${JSON.stringify(normalized, null, 2)}\n`;
  writeJsonAtomic(host, graphPath, normalized);
  return { normalized, raw };
}
