import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord } from '../../infra/json.js';
import type { GitSyncPathChange, GitSyncResult } from '../curate/git-sync.js';
import { noteEntryId, sourceEntryId } from '../entry-types.js';
import { stripMdExt } from '../paths.js';
import {
  extractBody,
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
} from './frontmatter.js';
import {
  captureCommunityManifestDelta,
  captureEntityGraphManifestDelta,
  captureNoteManifestDeltas,
  capturePrincipleManifestDelta,
  captureRemovedCommunityManifestDelta,
  captureRemovedNoteManifestDeltas,
  captureRemovedPrincipleManifestDelta,
  captureRemovedSourceManifestDeltas,
  captureSourceManifestDeltas,
  collectFullManifestSurfaceHashes,
  type ManifestAuthority,
} from './manifest-authority.js';
import type { ManifestAuthorityDelta } from './manifest-types.js';
import { sortedMarkdownEntries } from './markdown-entries.js';
import {
  type CanonicalFrontmatterRecord,
  computeContentSurfaceHash,
  computeMetadataSurfaceHash,
} from './snapshot.js';
import type { KbIndexMutationLane, KbRuntime } from '../contracts.js';
import { mergeMutationLane } from './lanes.js';

type InboundSyncTarget = Pick<
  KbRuntime,
  | 'notesDir'
  | 'sourcesDir'
  | 'principlesDir'
  | 'communitiesDir'
  | 'entityGraphPath'
  | 'notePath'
  | 'sourcePath'
  | 'communityPath'
  | 'principlePath'
>;

export type InboundSyncMutationDiff = {
  lane: KbIndexMutationLane | null;
  changedEntryIds: string[];
  requiresFullInstall: boolean;
  manifestDeltas: ManifestAuthorityDelta[];
};

type InboundSyncTrackedPath =
  | { kind: 'note'; slug: string }
  | { kind: 'source'; slug: string }
  | { kind: 'community'; slug: string }
  | { kind: 'principle'; slug: string }
  | { kind: 'entity-graph' };

export type CorpusFilesystemSnapshot = {
  notes: Map<string, { contentHash: string; metadataHash: string }>;
  sources: Map<string, { contentHash: string; metadataHash: string }>;
  principles: Map<string, string>;
  communities: Map<string, string>;
  entityGraphHash: string | null;
};

function normalizeInboundSyncPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveInboundSyncTrackedPath(path: string): InboundSyncTrackedPath | null {
  const normalized = normalizeInboundSyncPath(path);
  if (normalized === '.entity-graph.json') {
    return { kind: 'entity-graph' };
  }

  const noteMatch = normalized.match(/^notes\/(.+)\.md$/);
  if (noteMatch !== null) {
    return {
      kind: 'note',
      slug: noteMatch[1] ?? '',
    };
  }

  const sourceMatch = normalized.match(/^sources\/(.+)\.md$/);
  if (sourceMatch !== null) {
    return {
      kind: 'source',
      slug: sourceMatch[1] ?? '',
    };
  }

  const communityMatch = normalized.match(/^communities\/(.+)\.md$/);
  if (communityMatch !== null) {
    return {
      kind: 'community',
      slug: communityMatch[1] ?? '',
    };
  }

  const principleMatch = normalized.match(/^principles\/(.+)\.md$/);
  if (principleMatch !== null) {
    return {
      kind: 'principle',
      slug: principleMatch[1] ?? '',
    };
  }

  return null;
}

export function isGitSyncResult(value: unknown): value is GitSyncResult {
  return isRecord(value) && typeof value.kind === 'string';
}

function captureNoteFileSnapshot(dirPath: string): Map<string, { contentHash: string; metadataHash: string }> {
  const snapshot = new Map<string, { contentHash: string; metadataHash: string }>();

  for (const entry of sortedMarkdownEntries(dirPath)) {
    const slug = stripMdExt(entry);
    const raw = readFileSync(join(dirPath, entry), 'utf-8');
    try {
      snapshot.set(slug, {
        contentHash: computeContentSurfaceHash({
          title: extractTitle(raw),
          body: extractBody(raw),
        }),
        metadataHash: computeMetadataSurfaceHash({
          frontmatter: parseFrontmatter(raw) as unknown as CanonicalFrontmatterRecord,
        }),
      });
    } catch {
      const rawHash = createHash('sha256').update(raw).digest('hex');
      snapshot.set(slug, {
        contentHash: rawHash,
        metadataHash: rawHash,
      });
    }
  }

  return snapshot;
}

function captureSourceFileSnapshot(dirPath: string): Map<string, { contentHash: string; metadataHash: string }> {
  const snapshot = new Map<string, { contentHash: string; metadataHash: string }>();

  for (const entry of sortedMarkdownEntries(dirPath)) {
    const slug = stripMdExt(entry);
    const raw = readFileSync(join(dirPath, entry), 'utf-8');
    try {
      const { title, ...metadata } = parseSourceFrontmatter(raw);
      snapshot.set(slug, {
        contentHash: computeContentSurfaceHash({
          title,
          body: extractBody(raw),
        }),
        metadataHash: computeMetadataSurfaceHash({
          frontmatter: metadata as unknown as CanonicalFrontmatterRecord,
        }),
      });
    } catch {
      const rawHash = createHash('sha256').update(raw).digest('hex');
      snapshot.set(slug, {
        contentHash: rawHash,
        metadataHash: rawHash,
      });
    }
  }

  return snapshot;
}

function captureMarkdownFileHashes(dirPath: string): Map<string, string> {
  const snapshot = new Map<string, string>();

  for (const entry of sortedMarkdownEntries(dirPath)) {
    snapshot.set(stripMdExt(entry), createHash('sha256').update(readFileSync(join(dirPath, entry), 'utf-8')).digest('hex'));
  }

  return snapshot;
}

function captureEntityGraphHash(filePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(filePath, 'utf-8')).digest('hex');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

export function captureCorpusFilesystemSnapshot(target: InboundSyncTarget): CorpusFilesystemSnapshot {
  return {
    notes: captureNoteFileSnapshot(target.notesDir()),
    sources: captureSourceFileSnapshot(target.sourcesDir()),
    principles: captureMarkdownFileHashes(target.principlesDir()),
    communities: captureMarkdownFileHashes(target.communitiesDir()),
    entityGraphHash: captureEntityGraphHash(target.entityGraphPath()),
  };
}

function inboundSnapshotMapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  return (
    left.size === right.size &&
    [...left.entries()].every(([key, value]) => right.get(key) === value)
  );
}

export function detectInboundSyncMutation(
  before: CorpusFilesystemSnapshot,
  after: CorpusFilesystemSnapshot,
): InboundSyncMutationDiff {
  let lane: KbIndexMutationLane | null = null;
  const changedEntryIds = new Set<string>();

  const noteSlugs = new Set([...before.notes.keys(), ...after.notes.keys()]);
  for (const slug of noteSlugs) {
    const beforeEntry = before.notes.get(slug);
    const afterEntry = after.notes.get(slug);
    if (beforeEntry === undefined && afterEntry === undefined) {
      continue;
    }

    changedEntryIds.add(noteEntryId(slug));
    if (beforeEntry === undefined || afterEntry === undefined) {
      lane = mergeMutationLane(lane, 'both');
      continue;
    }
    if (beforeEntry.contentHash !== afterEntry.contentHash) {
      lane = mergeMutationLane(lane, 'content');
    }
    if (beforeEntry.metadataHash !== afterEntry.metadataHash) {
      lane = mergeMutationLane(lane, 'metadata');
    }
  }

  const sourceSlugs = new Set([...before.sources.keys(), ...after.sources.keys()]);
  for (const slug of sourceSlugs) {
    const beforeEntry = before.sources.get(slug);
    const afterEntry = after.sources.get(slug);
    if (beforeEntry === undefined && afterEntry === undefined) {
      continue;
    }

    changedEntryIds.add(sourceEntryId(slug));
    if (beforeEntry === undefined || afterEntry === undefined) {
      lane = mergeMutationLane(lane, 'both');
      continue;
    }
    if (beforeEntry.contentHash !== afterEntry.contentHash) {
      lane = mergeMutationLane(lane, 'content');
    }
    if (beforeEntry.metadataHash !== afterEntry.metadataHash) {
      lane = mergeMutationLane(lane, 'metadata');
    }
  }

  const principlesChanged = !inboundSnapshotMapsEqual(before.principles, after.principles);
  const communitiesChanged = !inboundSnapshotMapsEqual(before.communities, after.communities);
  const entityGraphChanged = before.entityGraphHash !== after.entityGraphHash;

  if (principlesChanged || communitiesChanged || entityGraphChanged) {
    lane = mergeMutationLane(lane, 'metadata');
  }

  return {
    lane,
    changedEntryIds: [...changedEntryIds].sort(),
    requiresFullInstall: principlesChanged || communitiesChanged || entityGraphChanged,
    manifestDeltas: [],
  };
}

function captureInboundSyncTrackedPathDeltas(
  target: InboundSyncTarget,
  trackedPath: InboundSyncTrackedPath,
  mode: 'present' | 'deleted',
): ManifestAuthorityDelta[] {
  if (trackedPath.kind === 'note') {
    if (mode === 'deleted') {
      return captureRemovedNoteManifestDeltas(trackedPath.slug);
    }
    try {
      return captureNoteManifestDeltas(trackedPath.slug, readFileSync(target.notePath(trackedPath.slug), 'utf-8'));
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return captureRemovedNoteManifestDeltas(trackedPath.slug);
      }
      throw error;
    }
  }

  if (trackedPath.kind === 'source') {
    if (mode === 'deleted') {
      return captureRemovedSourceManifestDeltas(trackedPath.slug);
    }
    try {
      return captureSourceManifestDeltas(trackedPath.slug, readFileSync(target.sourcePath(trackedPath.slug), 'utf-8'));
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return captureRemovedSourceManifestDeltas(trackedPath.slug);
      }
      throw error;
    }
  }

  if (trackedPath.kind === 'community') {
    if (mode === 'deleted') {
      return captureRemovedCommunityManifestDelta(trackedPath.slug);
    }
    try {
      return captureCommunityManifestDelta(trackedPath.slug, readFileSync(target.communityPath(trackedPath.slug), 'utf-8'));
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return captureRemovedCommunityManifestDelta(trackedPath.slug);
      }
      throw error;
    }
  }

  if (trackedPath.kind === 'principle') {
    if (mode === 'deleted') {
      return captureRemovedPrincipleManifestDelta(trackedPath.slug);
    }
    try {
      return capturePrincipleManifestDelta(trackedPath.slug, readFileSync(target.principlePath(trackedPath.slug), 'utf-8'));
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return captureRemovedPrincipleManifestDelta(trackedPath.slug);
      }
      throw error;
    }
  }

  if (mode === 'deleted') {
    return captureEntityGraphManifestDelta(null);
  }

  try {
    return captureEntityGraphManifestDelta(readFileSync(target.entityGraphPath(), 'utf-8'));
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return captureEntityGraphManifestDelta(null);
    }
    throw error;
  }
}

function applyInboundSyncTrackedPathChange(
  target: InboundSyncTarget,
  manifestAuthority: ManifestAuthority,
  trackedPath: InboundSyncTrackedPath,
  mode: 'present' | 'deleted',
  mutation: InboundSyncMutationDiff,
): void {
  const nextDeltas = captureInboundSyncTrackedPathDeltas(target, trackedPath, mode);
  let changed = false;

  for (const delta of nextDeltas) {
    const previousHash = manifestAuthority.getCurrentSurfaceHash(delta.lane, delta.manifestId);
    if (previousHash === delta.surfaceHash) {
      continue;
    }

    mutation.manifestDeltas.push(delta);
    mutation.lane = mergeMutationLane(mutation.lane, delta.lane);
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (trackedPath.kind === 'note') {
    mutation.changedEntryIds.push(noteEntryId(trackedPath.slug));
    return;
  }

  if (trackedPath.kind === 'source') {
    mutation.changedEntryIds.push(sourceEntryId(trackedPath.slug));
    return;
  }

  mutation.requiresFullInstall = true;
}

export function detectInboundSyncMutationFromStructuredDiff(
  changes: readonly GitSyncPathChange[],
  target: InboundSyncTarget,
  manifestAuthority: ManifestAuthority,
): InboundSyncMutationDiff {
  const mutation: InboundSyncMutationDiff = {
    lane: null,
    changedEntryIds: [],
    requiresFullInstall: false,
    manifestDeltas: [],
  };

  for (const change of changes) {
    if (change.status === 'renamed') {
      const previousTarget = resolveInboundSyncTrackedPath(change.previousPath);
      if (previousTarget !== null) {
        applyInboundSyncTrackedPathChange(target, manifestAuthority, previousTarget, 'deleted', mutation);
      }

      const nextTarget = resolveInboundSyncTrackedPath(change.path);
      if (nextTarget !== null) {
        applyInboundSyncTrackedPathChange(target, manifestAuthority, nextTarget, 'present', mutation);
      }
      continue;
    }

    const trackedPath = resolveInboundSyncTrackedPath(change.path);
    if (trackedPath === null) {
      continue;
    }

    applyInboundSyncTrackedPathChange(
      target,
      manifestAuthority,
      trackedPath,
      change.status === 'deleted' ? 'deleted' : 'present',
      mutation,
    );
  }

  mutation.changedEntryIds = [...new Set(mutation.changedEntryIds)].sort();
  return mutation;
}

export function detectInboundSyncMutationFromFullCollectors(
  target: InboundSyncTarget,
  manifestAuthority: ManifestAuthority,
  forceFullInstall = false,
): InboundSyncMutationDiff {
  const fullHashes = collectFullManifestSurfaceHashes(target);
  const currentContent = manifestAuthority.getCurrentSurfaceHashes('content');
  const currentMetadata = manifestAuthority.getCurrentSurfaceHashes('metadata');
  let lane: KbIndexMutationLane | null = null;
  let requiresFullInstall = false;
  const changedEntryIds = new Set<string>();

  for (const manifestId of new Set([...currentContent.keys(), ...fullHashes.content.keys()])) {
    const previousHash = currentContent.get(manifestId) ?? null;
    const nextHash = fullHashes.content.get(manifestId) ?? null;
    if (previousHash === nextHash) {
      continue;
    }

    lane = mergeMutationLane(lane, 'content');
    if (manifestId.startsWith('note:') || manifestId.startsWith('source:')) {
      changedEntryIds.add(manifestId);
    }
  }

  for (const manifestId of new Set([...currentMetadata.keys(), ...fullHashes.metadata.keys()])) {
    const previousHash = currentMetadata.get(manifestId) ?? null;
    const nextHash = fullHashes.metadata.get(manifestId) ?? null;
    if (previousHash === nextHash) {
      continue;
    }

    lane = mergeMutationLane(lane, 'metadata');
    if (manifestId.startsWith('note-meta:')) {
      changedEntryIds.add(noteEntryId(manifestId.slice('note-meta:'.length)));
      continue;
    }
    if (manifestId.startsWith('source-meta:')) {
      changedEntryIds.add(sourceEntryId(manifestId.slice('source-meta:'.length)));
      continue;
    }
    requiresFullInstall = true;
  }

  if (forceFullInstall && lane !== null) {
    requiresFullInstall = true;
  }

  if (lane !== null) {
    manifestAuthority.replaceCurrentSurfaceHashes(fullHashes);
  }

  return {
    lane,
    changedEntryIds: [...changedEntryIds].sort(),
    requiresFullInstall,
    manifestDeltas: [],
  };
}
