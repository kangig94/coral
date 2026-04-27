import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { StoragePort } from '../../../runtime/ports.js';
import { isRecord } from '../../../infra/json.js';
import { buildNoteIndexEntry, buildSourceIndexEntry } from '../index-records.js';
import { extractBody, parseSourceFrontmatter } from '../frontmatter.js';
import { computeContentSurfaceHash } from '../snapshot.js';
import { noteMetadataHash, sourceMetadataHash } from '../../metadata-hash.js';
import { loadKbNote } from '../../read.js';
import { readCurateRetryQueue } from '../../curate/retry.js';
import type { PendingRepair } from '../../curate/state/model.js';
import type { KbIndexMutationLane, KbIndexState, KbRuntime } from '../../contract.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type EntityGraph,
  type EntityRelationship,
  type KbIndex,
} from '../../entry-types.js';
import { projectIncidents } from './projections.js';
import type { CorpusEntityGraphScan, CorpusMarkdownFileScan, CorpusScanView } from './scan.js';
import type { DetectedIncident } from './incidents/catalog.js';

const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';

type StoredAuthorityHashes = {
  contentHash: string;
  metadataHash: string;
};

export function mergeMutationLane(
  current: KbIndexMutationLane | null,
  next: KbIndexMutationLane | null,
): KbIndexMutationLane | null {
  if (next === null || current === 'both') {
    return current;
  }
  if (current === null || current === next) {
    return next;
  }
  return 'both';
}

function modifiedAtNs(storagePort: StoragePort, path: string): bigint | null {
  try {
    return storagePort.statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

function markdownDirModifiedAfter(
  storagePort: StoragePort,
  dir: string,
  files: readonly CorpusMarkdownFileScan[],
  threshold: bigint,
): boolean {
  const dirModifiedAt = modifiedAtNs(storagePort, dir);
  if (dirModifiedAt !== null && dirModifiedAt > threshold) {
    return true;
  }

  return files.some((file) => fileModifiedAfter(storagePort, file.path, threshold));
}

function fileModifiedAfter(storagePort: StoragePort, filePath: string, threshold: bigint): boolean {
  const modifiedAt = modifiedAtNs(storagePort, filePath);
  return modifiedAt !== null && modifiedAt > threshold;
}

function collectStoredAuthorityHashes(value: unknown, hashes: Map<string, StoredAuthorityHashes>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStoredAuthorityHashes(entry, hashes);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const entryId = typeof value.entryId === 'string' ? value.entryId : null;
  const contentHash = typeof value.contentHash === 'string' ? value.contentHash : null;
  const metadataHash = typeof value.metadataHash === 'string' ? value.metadataHash : null;
  if (entryId !== null && contentHash !== null && metadataHash !== null) {
    hashes.set(entryId, {
      contentHash,
      metadataHash,
    });
  }

  for (const child of Object.values(value)) {
    collectStoredAuthorityHashes(child, hashes);
  }
}

function readStoredOramaAuthorityHashes(
  storagePort: StoragePort,
  runtimeDir: string,
): Map<string, StoredAuthorityHashes> {
  const snapshotPath = join(runtimeDir, ORAMA_INDEX_FILE);
  try {
    const parsed = JSON.parse(storagePort.readFileSync(snapshotPath, 'utf-8')) as unknown;
    const hashes = new Map<string, StoredAuthorityHashes>();
    collectStoredAuthorityHashes(parsed, hashes);
    return hashes;
  } catch {
    return new Map<string, StoredAuthorityHashes>();
  }
}

function classifyAuthorityDrift(
  previous: StoredAuthorityHashes | undefined,
  current: StoredAuthorityHashes,
  fallback: {
    contentChangedByIndex: boolean;
    metadataChangedByIndex: boolean;
    fileModifiedAfterIndex: boolean;
  },
): KbIndexMutationLane | null {
  let lane: KbIndexMutationLane | null = null;

  if (previous !== undefined) {
    if (previous.contentHash !== current.contentHash) {
      lane = mergeMutationLane(lane, 'content');
    }
    if (previous.metadataHash !== current.metadataHash) {
      lane = mergeMutationLane(lane, 'metadata');
    }
    return lane;
  }

  if (fallback.contentChangedByIndex) {
    lane = mergeMutationLane(lane, 'content');
  }
  if (fallback.metadataChangedByIndex) {
    lane = mergeMutationLane(lane, 'metadata');
  }
  if (lane === null && fallback.fileModifiedAfterIndex) {
    lane = 'content';
  }

  return lane;
}

type IndexEntry = KbIndex['entries'][string];

interface KindDriftLoaders<E extends IndexEntry> {
  readonly entryId: (slug: string) => string;
  readonly loadEntry: (file: CorpusMarkdownFileScan) => {
    next: E;
    contentHash: string;
  };
  readonly isMatchingKind: (entry: IndexEntry) => entry is E;
  readonly metadataHash: (entry: E) => string;
}

function detectKindDrift<E extends IndexEntry>(
  storagePort: StoragePort,
  kind: CorpusMarkdownFileScan['kind'],
  scan: CorpusScanView,
  index: KbIndex,
  storedHashes: Map<string, StoredAuthorityHashes>,
  indexMtime: bigint,
  pendingRepairIds: ReadonlySet<string>,
  loaders: KindDriftLoaders<E>,
): KbIndexMutationLane | null {
  let lane: KbIndexMutationLane | null = null;
  const seenSlugs = new Set<string>();

  for (const file of scan.markdownFiles) {
    if (file.kind !== kind) {
      continue;
    }
    seenSlugs.add(file.slug);
    const entryId = loaders.entryId(file.slug);
    if (pendingRepairIds.has(entryId)) {
      continue;
    }
    try {
      const { next, contentHash } = loaders.loadEntry(file);
      const existingEntry = index.entries[entryId];
      const existing = existingEntry !== undefined && loaders.isMatchingKind(existingEntry) ? existingEntry : undefined;
      if (existing === undefined) {
        lane = mergeMutationLane(lane, 'both');
        continue;
      }
      lane = mergeMutationLane(
        lane,
        classifyAuthorityDrift(
          storedHashes.get(entryId),
          {
            contentHash,
            metadataHash: loaders.metadataHash(next),
          },
          {
            contentChangedByIndex: existing.title !== next.title,
            metadataChangedByIndex: loaders.metadataHash(existing) !== loaders.metadataHash(next),
            fileModifiedAfterIndex: fileModifiedAfter(storagePort, file.path, indexMtime),
          },
        ),
      );
    } catch {
      return 'both';
    }
  }

  for (const entry of Object.values(index.entries)) {
    if (loaders.isMatchingKind(entry) && !seenSlugs.has(entry.slug)) {
      lane = mergeMutationLane(lane, 'both');
    }
  }

  return lane;
}

function detectStructuredTextDrift(
  kb: Pick<KbRuntime, 'runtimeDir' | 'storagePort'>,
  scan: CorpusScanView,
  index: KbIndex,
  pendingRepairIds: ReadonlySet<string>,
  indexMtime: bigint,
): KbIndexMutationLane | null {
  const storedAuthorityHashes = readStoredOramaAuthorityHashes(kb.storagePort, kb.runtimeDir);

  const noteLane = detectKindDrift(
    kb.storagePort,
    'note',
    scan,
    index,
    storedAuthorityHashes,
    indexMtime,
    pendingRepairIds,
    {
      entryId: noteEntryId,
      loadEntry: (file) => {
        const loaded = loadKbNote(file.path);
        const next = buildNoteIndexEntry({
          slug: file.slug,
          title: loaded.title,
          ...loaded.frontmatter,
        });
        return {
          next,
          contentHash: computeContentSurfaceHash({ title: loaded.title, body: loaded.body }),
        };
      },
      isMatchingKind: isNoteEntry,
      metadataHash: noteMetadataHash,
    },
  );

  const sourceLane = detectKindDrift(
    kb.storagePort,
    'source',
    scan,
    index,
    storedAuthorityHashes,
    indexMtime,
    pendingRepairIds,
    {
      entryId: sourceEntryId,
      loadEntry: (file) => {
        const raw = kb.storagePort.readFileSync(file.path, 'utf-8');
        const next = buildSourceIndexEntry({
          slug: file.slug,
          ...parseSourceFrontmatter(raw),
        });
        return {
          next,
          contentHash: computeContentSurfaceHash({ title: next.title, body: extractBody(raw) }),
        };
      },
      isMatchingKind: isSourceEntry,
      metadataHash: sourceMetadataHash,
    },
  );

  return mergeMutationLane(noteLane, sourceLane);
}

/**
 * Pure projection: returns a `MutationLane` when the incident retry queue and the
 * current scan disagree (a row whose entryId no longer matches a current incident,
 * a current incident with no row, or a content-hash drift on a matched row). Folds
 * what was previously a separate retry-queue freshness gate into the corpus-scan freshness gate.
 */
export function detectIncidentRetryDrift(
  retryQueue: ReadonlyArray<PendingRepair>,
  incidents: ReadonlyArray<DetectedIncident>,
  scan: CorpusScanView,
): KbIndexMutationLane | null {
  if (retryQueue.length === 0 && incidents.length === 0) {
    return null;
  }

  const queueByEntryId = new Map<string, PendingRepair>();
  for (const row of retryQueue) {
    queueByEntryId.set(row.entryId, row);
  }
  const incidentEntryIds = new Set<string>();
  for (const incident of incidents) {
    incidentEntryIds.add(incident.entryId);
  }
  const contentByEntryId = new Map<string, string>();
  for (const file of scan.markdownFiles) {
    contentByEntryId.set(file.entryId, file.content);
  }

  for (const entryId of queueByEntryId.keys()) {
    if (!incidentEntryIds.has(entryId)) {
      return 'both';
    }
  }
  for (const entryId of incidentEntryIds) {
    if (!queueByEntryId.has(entryId)) {
      return 'both';
    }
  }
  for (const [entryId, row] of queueByEntryId) {
    if (row.observedContentHash === undefined) {
      return 'both';
    }
    const content = contentByEntryId.get(entryId);
    if (content === undefined) {
      return 'both';
    }
    const currentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (currentHash !== row.observedContentHash) {
      return 'both';
    }
  }

  return null;
}

export function detectRescanInfo(
  kb: Pick<
    KbRuntime,
    | 'runtimeDir'
    | 'storagePort'
    | 'db'
    | 'readIndex'
    | 'notesDir'
    | 'sourcesDir'
    | 'communitiesDir'
    | 'principlesDir'
  >,
  scan: CorpusScanView,
): {
  needsRebuild: boolean;
  externalMutation: KbIndexMutationLane | null;
} {
  const indexPath = join(kb.runtimeDir, INDEX_FILE);
  if (!kb.storagePort.existsSync(indexPath)) {
    return {
      needsRebuild: true,
      externalMutation: null,
    };
  }

  try {
    const indexMtime = kb.storagePort.statSync(indexPath, { bigint: true }).mtimeNs;
    const currentIndex = kb.readIndex();
    const retryQueue = readCurateRetryQueue(kb.db);
    const pendingRepairIds = new Set(retryQueue.map((entry) => entry.entryId));
    let externalMutation: KbIndexMutationLane | null = null;

    if (currentIndex !== null) {
      externalMutation = mergeMutationLane(
        externalMutation,
        detectEntityGraphDrift(scan.entityGraph, currentIndex),
      );
    }

    const principleFiles = scan.markdownFiles.filter((file) => file.kind === 'principle');
    const communityFiles = scan.markdownFiles.filter((file) => file.kind === 'community');
    if (
      markdownDirModifiedAfter(kb.storagePort, kb.principlesDir(), principleFiles, indexMtime) ||
      markdownDirModifiedAfter(kb.storagePort, kb.communitiesDir(), communityFiles, indexMtime)
    ) {
      externalMutation = mergeMutationLane(externalMutation, 'metadata');
    }

    if (currentIndex !== null) {
      externalMutation = mergeMutationLane(
        externalMutation,
        detectStructuredTextDrift(kb, scan, currentIndex, pendingRepairIds, indexMtime),
      );
    }

    externalMutation = mergeMutationLane(
      externalMutation,
      detectIncidentRetryDrift(retryQueue, projectIncidents(scan), scan),
    );

    return {
      needsRebuild: externalMutation !== null,
      externalMutation,
    };
  } catch {
    return {
      needsRebuild: true,
      externalMutation: 'both',
    };
  }
}

/**
 * Pure projection: returns `'metadata'` when the scanned `.entity-graph.json`
 * disagrees with the entity slice projected into `currentIndex`. Folds the
 * previous standalone mtime-based branch into the unified MutationLane emitter,
 * eliminating the false-positive of a touch-without-content-change rebuild.
 */
export function detectEntityGraphDrift(
  scanned: CorpusEntityGraphScan | null,
  currentIndex: Pick<KbIndex, 'entityMeta' | 'relationships'>,
): KbIndexMutationLane | null {
  const indexedGraph: EntityGraph = {
    entityMeta: currentIndex.entityMeta,
    relationships: currentIndex.relationships,
  };
  const scannedGraph = scanned?.graph ?? EMPTY_ENTITY_GRAPH;
  return graphsEqual(scannedGraph, indexedGraph) ? null : 'metadata';
}

const EMPTY_ENTITY_GRAPH: EntityGraph = { entityMeta: {}, relationships: [] };

function graphsEqual(left: EntityGraph, right: EntityGraph): boolean {
  return (
    canonicalEntityMeta(left.entityMeta) === canonicalEntityMeta(right.entityMeta) &&
    canonicalRelationships(left.relationships) === canonicalRelationships(right.relationships)
  );
}

function canonicalEntityMeta(entityMeta: EntityGraph['entityMeta']): string {
  const sortedEntries = Object.entries(entityMeta)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, meta]) => [
      name,
      {
        type: meta.type,
        description: meta.description,
        ...(meta.aliases === undefined ? {} : { aliases: [...meta.aliases].sort((a, b) => a.localeCompare(b)) }),
      },
    ]);
  return JSON.stringify(sortedEntries);
}

function canonicalRelationships(relationships: readonly EntityRelationship[]): string {
  // Order is significant: relationships[0] vs [1] are distinct entries in the
  // index. Sorting would mask reorders that are real authority writes.
  return JSON.stringify(
    relationships.map((relationship) => ({
      source: relationship.source,
      target: relationship.target,
      type: relationship.type,
      description: relationship.description,
      evidence: [...relationship.evidence],
    })),
  );
}

export function applyLaneMutation(
  state: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
  lane: KbIndexMutationLane | null,
): Pick<KbIndexState, 'contentSeq' | 'metadataSeq'> {
  if (lane === null) {
    return state;
  }

  const nextSeq = Math.max(state.contentSeq, state.metadataSeq) + 1;
  return {
    contentSeq: lane === 'content' || lane === 'both' ? nextSeq : state.contentSeq,
    metadataSeq: lane === 'metadata' || lane === 'both' ? nextSeq : state.metadataSeq,
  };
}
