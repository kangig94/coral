import { createHash } from 'node:crypto';

import { noteEntryId, sourceEntryId, wikiEntryId } from '../entry-types.js';
import { buildNoteIndexEntry, buildSourceIndexEntry } from './index/records.js';
import type { KbIndexMutationLane } from '../contract.js';
import { mergeMutationLane } from './lanes.js';
import {
  captureCommunityManifestDelta,
  captureEntityGraphManifestDelta,
  captureNoteManifestDeltas,
  capturePrincipleManifestDelta,
  captureSourceManifestDeltas,
  captureWikiManifestDeltas,
  computeManifestHashFromSurfaceHashes,
  type FullManifestSurfaceHashes,
  type ManifestAuthority,
} from './manifest-authority.js';
import type { CorpusAuthorityBaselineRecord } from './authority-baseline-contract.js';
import type { ManifestAuthorityDelta, ManifestAuthorityLane } from './manifest-types.js';
import {
  extractBody,
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
  parseWikiBody,
  parseWikiFrontmatter,
} from './frontmatter.js';
import { noteMetadataHash, sourceMetadataHash, wikiMetadataHash } from '../metadata-hash.js';
import { computeContentSurfaceHash, computeMetadataSurfaceHash } from './snapshot.js';
import { buildCorpusScanView, type CorpusMarkdownFileScan, type CorpusScanView } from './rescan/scan.js';

export type CorpusSurface = {
  readonly manifest: FullManifestSurfaceHashes;
  readonly baselineRecords: readonly CorpusAuthorityBaselineRecord[];
};

export type CorpusSurfaceMutationDiff = {
  lane: KbIndexMutationLane | null;
  changedEntryIds: string[];
  requiresFullInstall: boolean;
  manifestDeltas: ManifestAuthorityDelta[];
};

type SurfaceDiffAuthority = Pick<ManifestAuthority, 'getCurrentSurfaceHashes'>;

export function buildCorpusSurface(scan: CorpusScanView): CorpusSurface {
  const content = new Map<string, string>();
  const metadata = new Map<string, string>();
  const baselineRecords: CorpusAuthorityBaselineRecord[] = [];

  for (const file of scan.markdownFiles) {
    applyDeltasToSurfaceHashes(content, metadata, captureFileManifestDeltas(file));
    baselineRecords.push(buildFileBaselineRecord(file));
  }

  if (scan.entityGraph !== null) {
    applyDeltasToSurfaceHashes(content, metadata, captureEntityGraphManifestDelta(scan.entityGraph.content));
    baselineRecords.push({
      entryId: scan.entityGraph.entryId,
      contentHash: '',
      metadataHash: computeMetadataSurfaceHash({ rawBytes: scan.entityGraph.content }),
    });
  }

  return {
    manifest: { content, metadata },
    baselineRecords,
  };
}

export function buildCurrentCorpusSurface(kb: Parameters<typeof buildCorpusScanView>[0]): CorpusSurface {
  return buildCorpusSurface(buildCorpusScanView(kb));
}

export function collectCorpusAuthorityBaseline(scan: CorpusScanView): CorpusAuthorityBaselineRecord[] {
  return [...buildCorpusSurface(scan).baselineRecords];
}

export function computeCorpusSurfaceManifestHash(
  kb: Parameters<typeof buildCorpusScanView>[0],
  lane: ManifestAuthorityLane,
): string {
  return computeManifestHashFromSurfaceHashes(buildCurrentCorpusSurface(kb).manifest[lane]);
}

export function diffCorpusSurfaces(before: CorpusSurface, after: CorpusSurface): CorpusSurfaceMutationDiff {
  let lane: KbIndexMutationLane | null = null;
  let requiresFullInstall = false;
  const changedEntryIds = new Set<string>();
  const beforeRecords = baselineRecordsByEntryId(before.baselineRecords);
  const afterRecords = baselineRecordsByEntryId(after.baselineRecords);

  forEachMapKeyUnion(beforeRecords, afterRecords, (entryId) => {
    const beforeRecord = beforeRecords.get(entryId);
    const afterRecord = afterRecords.get(entryId);
    if (beforeRecord === undefined && afterRecord === undefined) {
      return;
    }

    if (isStructuredEntryId(entryId)) {
      changedEntryIds.add(entryId);
      if (beforeRecord === undefined || afterRecord === undefined) {
        lane = mergeMutationLane(lane, 'both');
        return;
      }
      if (beforeRecord.contentHash !== afterRecord.contentHash) {
        lane = mergeMutationLane(lane, 'content');
      }
      if (beforeRecord.metadataHash !== afterRecord.metadataHash) {
        lane = mergeMutationLane(lane, 'metadata');
      }
      return;
    }

    const beforeHash = beforeRecord?.metadataHash ?? null;
    const afterHash = afterRecord?.metadataHash ?? null;
    if (beforeHash !== afterHash) {
      lane = mergeMutationLane(lane, 'metadata');
      requiresFullInstall = true;
    }
  });

  return {
    lane,
    changedEntryIds: [...changedEntryIds].sort(),
    requiresFullInstall,
    manifestDeltas: diffManifestSurfaceHashes(before.manifest, after.manifest),
  };
}

export function diffCorpusSurfaceAgainstAuthority(
  surface: CorpusSurface,
  authority: SurfaceDiffAuthority,
  options: { forceFullInstall?: boolean } = {},
): CorpusSurfaceMutationDiff {
  const currentManifest: FullManifestSurfaceHashes = {
    content: new Map(authority.getCurrentSurfaceHashes('content')),
    metadata: new Map(authority.getCurrentSurfaceHashes('metadata')),
  };
  let lane: KbIndexMutationLane | null = null;
  let requiresFullInstall = false;
  const changedEntryIds = new Set<string>();

  forEachMapKeyUnion(currentManifest.content, surface.manifest.content, (manifestId) => {
    const previousHash = currentManifest.content.get(manifestId) ?? null;
    const nextHash = surface.manifest.content.get(manifestId) ?? null;
    if (previousHash === nextHash) {
      return;
    }

    lane = mergeMutationLane(lane, 'content');
    if (isStructuredEntryId(manifestId)) {
      changedEntryIds.add(manifestId);
    }
  });

  forEachMapKeyUnion(currentManifest.metadata, surface.manifest.metadata, (manifestId) => {
    const previousHash = currentManifest.metadata.get(manifestId) ?? null;
    const nextHash = surface.manifest.metadata.get(manifestId) ?? null;
    if (previousHash === nextHash) {
      return;
    }

    lane = mergeMutationLane(lane, 'metadata');
    const entryId = entryIdFromMetadataManifestId(manifestId);
    if (entryId === null) {
      requiresFullInstall = true;
      return;
    }
    changedEntryIds.add(entryId);
  });

  if (options.forceFullInstall === true && lane !== null) {
    requiresFullInstall = true;
  }

  return {
    lane,
    changedEntryIds: [...changedEntryIds].sort(),
    requiresFullInstall,
    manifestDeltas: diffManifestSurfaceHashes(currentManifest, surface.manifest),
  };
}

function captureFileManifestDeltas(file: CorpusMarkdownFileScan): ManifestAuthorityDelta[] {
  switch (file.kind) {
    case 'note':
      return captureNoteManifestDeltas(file.slug, file.content);
    case 'source':
      return captureSourceManifestDeltas(file.slug, file.content);
    case 'wiki':
      return captureWikiManifestDeltas(file.slug, file.content);
    case 'community':
      return captureCommunityManifestDelta(file.slug, file.content);
    case 'principle':
      return capturePrincipleManifestDelta(file.slug, file.content);
  }
}

function buildFileBaselineRecord(file: CorpusMarkdownFileScan): CorpusAuthorityBaselineRecord {
  if (file.kind === 'note') {
    try {
      const frontmatter = parseFrontmatter(file.content);
      const title = extractTitle(file.content);
      const entry = buildNoteIndexEntry({
        slug: file.slug,
        title,
        body: extractBody(file.content),
        ...frontmatter,
      });
      return {
        entryId: file.entryId,
        contentHash: computeContentSurfaceHash({ title, body: extractBody(file.content) }),
        metadataHash: noteMetadataHash(entry),
      };
    } catch {
      return rawBaselineRecord(file.entryId, file.content);
    }
  }

  if (file.kind === 'source') {
    try {
      const { title, ...metadata } = parseSourceFrontmatter(file.content);
      const entry = buildSourceIndexEntry({
        slug: file.slug,
        title,
        body: extractBody(file.content),
        ...metadata,
      });
      return {
        entryId: file.entryId,
        contentHash: computeContentSurfaceHash({ title, body: extractBody(file.content) }),
        metadataHash: sourceMetadataHash(entry),
      };
    } catch {
      return rawBaselineRecord(file.entryId, file.content);
    }
  }

  if (file.kind === 'wiki') {
    try {
      const metadata = parseWikiFrontmatter(file.content);
      const title = extractTitle(file.content);
      const body = extractBody(file.content);
      parseWikiBody(body);
      return {
        entryId: file.entryId,
        contentHash: computeContentSurfaceHash({ title, body }),
        metadataHash: wikiMetadataHash(metadata),
      };
    } catch {
      return rawBaselineRecord(file.entryId, file.content);
    }
  }

  return {
    entryId: file.entryId,
    contentHash: '',
    metadataHash: computeMetadataSurfaceHash({ rawBytes: file.content }),
  };
}

function rawBaselineRecord(entryId: string, content: string): CorpusAuthorityBaselineRecord {
  const rawHash = createHash('sha256').update(content, 'utf8').digest('hex');
  return {
    entryId,
    contentHash: rawHash,
    metadataHash: rawHash,
  };
}

function baselineRecordsByEntryId(
  records: readonly CorpusAuthorityBaselineRecord[],
): Map<string, CorpusAuthorityBaselineRecord> {
  const byEntryId = new Map<string, CorpusAuthorityBaselineRecord>();
  for (const record of records) {
    byEntryId.set(record.entryId, record);
  }
  return byEntryId;
}

function diffManifestSurfaceHashes(
  before: FullManifestSurfaceHashes,
  after: FullManifestSurfaceHashes,
): ManifestAuthorityDelta[] {
  return [
    ...diffManifestLaneSurfaceHashes('content', before.content, after.content),
    ...diffManifestLaneSurfaceHashes('metadata', before.metadata, after.metadata),
  ];
}

function diffManifestLaneSurfaceHashes(
  lane: ManifestAuthorityLane,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): ManifestAuthorityDelta[] {
  const deltas: ManifestAuthorityDelta[] = [];
  forEachMapKeyUnion(before, after, (manifestId) => {
    const previousHash = before.get(manifestId) ?? null;
    const nextHash = after.get(manifestId) ?? null;
    if (previousHash === nextHash) {
      return;
    }
    deltas.push({ lane, manifestId, surfaceHash: nextHash });
  });
  return deltas;
}

function applyDeltasToSurfaceHashes(
  content: Map<string, string>,
  metadata: Map<string, string>,
  deltas: readonly ManifestAuthorityDelta[],
): void {
  for (const delta of deltas) {
    const target = delta.lane === 'content' ? content : metadata;
    if (delta.surfaceHash === null) {
      target.delete(delta.manifestId);
      continue;
    }
    target.set(delta.manifestId, delta.surfaceHash);
  }
}

function isStructuredEntryId(entryId: string): boolean {
  return entryId.startsWith('note:') || entryId.startsWith('source:') || entryId.startsWith('wiki:');
}

function entryIdFromMetadataManifestId(manifestId: string): string | null {
  if (manifestId.startsWith('note-meta:')) {
    return noteEntryId(manifestId.slice('note-meta:'.length));
  }
  if (manifestId.startsWith('source-meta:')) {
    return sourceEntryId(manifestId.slice('source-meta:'.length));
  }
  if (manifestId.startsWith('wiki-meta:')) {
    return wikiEntryId(manifestId.slice('wiki-meta:'.length));
  }
  return null;
}

function forEachMapKeyUnion<TLeft, TRight>(
  left: ReadonlyMap<string, TLeft>,
  right: ReadonlyMap<string, TRight>,
  visit: (key: string) => void,
): void {
  const seen = new Set<string>();
  for (const key of left.keys()) {
    seen.add(key);
    visit(key);
  }
  for (const key of right.keys()) {
    if (seen.has(key)) {
      continue;
    }
    visit(key);
  }
}
