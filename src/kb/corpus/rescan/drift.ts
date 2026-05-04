import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { StoragePort } from '../../../infra/port-types.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, buildWikiIndexEntry } from '../index-records.js';
import {
  extractBody,
  extractTitle,
  parseSourceFrontmatter,
  parseWikiBody,
  parseWikiFrontmatter,
} from '../frontmatter.js';
import { computeContentSurfaceHash } from '../snapshot.js';
import { noteMetadataHash, sourceMetadataHash, wikiMetadataHash } from '../../metadata-hash.js';
import { loadKbNote } from '../../read.js';
import { readCurateRetryQueue } from '../../curate/retry.js';
import type { PendingRepair } from '../../curate/state/model.js';
import type { KbCorpusSnapshot, KbIndexMutationLane, KbRuntime } from '../../contract.js';
import { mergeMutationLane } from '../lanes.js';
import type { CorpusInterest } from '../../../store/consumer-contract.js';
import {
  isNoteEntry,
  isSourceEntry,
  isWikiEntry,
  noteEntryId,
  sourceEntryId,
  wikiEntryId,
  type EntityGraph,
  type EntityRelationship,
  type KbIndex,
} from '../../entry-types.js';
import { extractWikiKnowledgeLinks, projectIncidents } from './projections.js';
import type { CorpusEntityGraphScan, CorpusMarkdownFileScan, CorpusScanView } from './scan.js';
import type { DetectedIncident } from './incidents/catalog.js';
import type { EngineArtifactDescriptor, EngineArtifactProjectedSnapshot } from '../artifact-port.js';
import type { CorpusAuthorityBaselineMap, CorpusAuthorityBaselineRecord } from '../authority-baseline-contract.js';
import { curateDb } from '../../curate/db-access.js';

const INDEX_FILE = 'index.json';

export type ProjectionArtifactLag = {
  readonly artifactId: string;
  readonly targetConsumerIds: readonly string[];
  readonly diagnostic: string;
};

export type RescanInfo = {
  readonly needsRebuild: boolean;
  readonly externalMutation: KbIndexMutationLane | null;
  readonly projectionArtifactLag: readonly ProjectionArtifactLag[];
};

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

function classifyAuthorityDrift(
  previous: CorpusAuthorityBaselineRecord | undefined,
  current: Pick<CorpusAuthorityBaselineRecord, 'contentHash' | 'metadataHash'>,
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
  storedHashes: CorpusAuthorityBaselineMap,
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

async function detectStructuredTextDrift(
  kb: Pick<KbRuntime, 'runtimeDir' | 'storagePort'>,
  scan: CorpusScanView,
  index: KbIndex,
  pendingRepairIds: ReadonlySet<string>,
  indexMtime: bigint,
  storedAuthorityHashes: CorpusAuthorityBaselineMap,
): Promise<KbIndexMutationLane | null> {
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
        const loaded = loadKbNote(kb.storagePort, file.path);
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

  const wikiLane = detectKindDrift(
    kb.storagePort,
    'wiki',
    scan,
    index,
    storedAuthorityHashes,
    indexMtime,
    pendingRepairIds,
    {
      entryId: wikiEntryId,
      loadEntry: (file) => {
        const raw = kb.storagePort.readFileSync(file.path, 'utf-8');
        const frontmatter = parseWikiFrontmatter(raw);
        const title = extractTitle(raw);
        const body = extractBody(raw);
        const sections = parseWikiBody(body);
        const next = buildWikiIndexEntry({
          slug: file.slug,
          title,
          knowledge: extractWikiKnowledgeLinks(sections.knowledge),
          ...frontmatter,
        });
        return {
          next,
          contentHash: computeContentSurfaceHash({ title, body }),
        };
      },
      isMatchingKind: isWikiEntry,
      metadataHash: wikiMetadataHash,
    },
  );

  return mergeMutationLane(mergeMutationLane(noteLane, sourceLane), wikiLane);
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

function projectedSnapshotMatchesInterest(
  current: KbCorpusSnapshot,
  projected: EngineArtifactProjectedSnapshot,
  interest: CorpusInterest,
): boolean {
  if (interest === 'both' && projected.snapshotId !== current.snapshotId) {
    return false;
  }

  if (interest === 'content' || interest === 'both') {
    if (projected.contentSeq !== current.contentSeq || projected.contentManifestHash !== current.contentManifestHash) {
      return false;
    }
  }

  if (interest === 'metadata' || interest === 'both') {
    if (
      projected.metadataSeq !== current.metadataSeq ||
      projected.metadataManifestHash !== current.metadataManifestHash
    ) {
      return false;
    }
  }

  return true;
}

function projectionLagDiagnostic(descriptor: EngineArtifactDescriptor, current: KbCorpusSnapshot): string | null {
  if (descriptor.freshness.status === 'missing') {
    return 'projection artifact is missing';
  }
  if (descriptor.freshness.status === 'corrupt') {
    return descriptor.freshness.diagnostic;
  }
  if (descriptor.freshness.projected.projectionIdentityHash !== descriptor.expectedProjectionIdentityHash) {
    return 'projection identity differs from the currently registered projection';
  }
  if (!projectedSnapshotMatchesInterest(current, descriptor.freshness.projected, descriptor.corpusInterest)) {
    return 'projection artifact does not match the current corpus snapshot';
  }
  return null;
}

export function detectProjectionArtifactLag(
  kb: Pick<KbRuntime, 'getCorpusStateSnapshot'>,
  descriptors: readonly EngineArtifactDescriptor[],
): readonly ProjectionArtifactLag[] {
  const current = kb.getCorpusStateSnapshot();
  return descriptors.flatMap((descriptor) => {
    const diagnostic = projectionLagDiagnostic(descriptor, current);
    if (diagnostic === null) {
      return [];
    }
    return [
      {
        artifactId: descriptor.artifactId,
        targetConsumerIds: descriptor.targetConsumerIds,
        diagnostic,
      },
    ];
  });
}

export async function detectRescanInfo(kb: KbRuntime, scan: CorpusScanView): Promise<RescanInfo> {
  const artifactDescriptors = await kb.engineArtifactRegistry.describeArtifacts();
  const projectionArtifactLag = detectProjectionArtifactLag(kb, artifactDescriptors);
  const indexPath = join(kb.runtimeDir, INDEX_FILE);
  if (!kb.storagePort.existsSync(indexPath)) {
    return {
      needsRebuild: true,
      externalMutation: null,
      projectionArtifactLag,
    };
  }

  try {
    const baseline = kb.corpusAuthorityBaseline.ensure(scan);
    const storedAuthorityHashes = baseline.rebuilt ? new Map() : baseline.baseline;
    const indexMtime = kb.storagePort.statSync(indexPath, { bigint: true }).mtimeNs;
    const currentIndex = kb.readIndex();
    const retryQueue = readCurateRetryQueue(curateDb(kb));
    const pendingRepairIds = new Set(retryQueue.map((entry) => entry.entryId));
    let externalMutation: KbIndexMutationLane | null = null;

    if (currentIndex !== null) {
      externalMutation = mergeMutationLane(externalMutation, detectEntityGraphDrift(scan.entityGraph, currentIndex));
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
        await detectStructuredTextDrift(kb, scan, currentIndex, pendingRepairIds, indexMtime, storedAuthorityHashes),
      );
    }

    externalMutation = mergeMutationLane(
      externalMutation,
      detectIncidentRetryDrift(retryQueue, projectIncidents(scan), scan),
    );

    return {
      needsRebuild: externalMutation !== null,
      externalMutation,
      projectionArtifactLag,
    };
  } catch {
    return {
      needsRebuild: true,
      externalMutation: 'both',
      projectionArtifactLag,
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
