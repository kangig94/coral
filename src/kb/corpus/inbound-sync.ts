import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord } from '../../infra/json.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { GitSyncPathChange, GitSyncResult } from '../curate/git-sync.js';
import { noteEntryId, sourceEntryId, wikiEntryId, type KbIndex } from '../entry-types.js';
import { loadKbNote, loadKbSource } from '../read.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, buildWikiIndexEntry, cloneKbIndex } from './index/records.js';
import { extractKnowledgeLinks } from './wiki-links.js';
import { extractBody, extractTitle, parseWikiBody, parseWikiFrontmatter } from './frontmatter.js';
import {
  captureCommunityManifestDelta,
  captureEntityGraphManifestDelta,
  captureNoteManifestDeltas,
  capturePrincipleManifestDelta,
  captureRemovedCommunityManifestDelta,
  captureRemovedNoteManifestDeltas,
  captureRemovedPrincipleManifestDelta,
  captureRemovedSourceManifestDeltas,
  captureRemovedWikiManifestDeltas,
  captureSourceManifestDeltas,
  captureWikiManifestDeltas,
  type ManifestAuthority,
} from './manifest-authority.js';
import type { ManifestAuthorityDelta } from './manifest-types.js';
import {
  diffCorpusSurfaceAgainstAuthority,
  diffCorpusSurfaces,
  type CorpusSurface,
  type CorpusSurfaceMutationDiff,
} from './surface.js';
import type { KbRuntime } from '../contract.js';
import { mergeMutationLane } from './lanes.js';

type InboundSyncTarget = Pick<
  KbRuntime,
  'entityGraphPath' | 'notePath' | 'wikiPath' | 'sourcePath' | 'communityPath' | 'principlePath' | 'storagePort'
>;

export type InboundSyncMutationDiff = CorpusSurfaceMutationDiff;

type InboundSyncTrackedPath =
  | { kind: 'note'; slug: string }
  | { kind: 'wiki'; slug: string }
  | { kind: 'source'; slug: string }
  | { kind: 'community'; slug: string }
  | { kind: 'principle'; slug: string }
  | { kind: 'entity-graph' };

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

  const wikiMatch = normalized.match(/^wiki\/(.+)\.md$/);
  if (wikiMatch !== null) {
    return {
      kind: 'wiki',
      slug: wikiMatch[1] ?? '',
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

function uniqueSortedStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique.sort();
}

export function detectInboundSyncMutation(before: CorpusSurface, after: CorpusSurface): InboundSyncMutationDiff {
  return diffCorpusSurfaces(before, after);
}

function captureInboundSyncTrackedPathDeltas(
  target: InboundSyncTarget,
  trackedPath: InboundSyncTrackedPath,
  mode: 'present' | 'deleted',
): ManifestAuthorityDelta[] {
  const storage = target.storagePort;
  if (trackedPath.kind === 'note') {
    if (mode === 'deleted') {
      return captureRemovedNoteManifestDeltas(trackedPath.slug);
    }
    try {
      return captureNoteManifestDeltas(
        trackedPath.slug,
        storage.readFileSync(target.notePath(trackedPath.slug), 'utf-8'),
      );
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return captureRemovedNoteManifestDeltas(trackedPath.slug);
      }
      throw error;
    }
  }

  if (trackedPath.kind === 'wiki') {
    if (mode === 'deleted') {
      return captureRemovedWikiManifestDeltas(trackedPath.slug);
    }
    try {
      return captureWikiManifestDeltas(
        trackedPath.slug,
        storage.readFileSync(target.wikiPath(trackedPath.slug), 'utf-8'),
      );
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return captureRemovedWikiManifestDeltas(trackedPath.slug);
      }
      throw error;
    }
  }

  if (trackedPath.kind === 'source') {
    if (mode === 'deleted') {
      return captureRemovedSourceManifestDeltas(trackedPath.slug);
    }
    try {
      return captureSourceManifestDeltas(
        trackedPath.slug,
        storage.readFileSync(target.sourcePath(trackedPath.slug), 'utf-8'),
      );
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
      return captureCommunityManifestDelta(
        trackedPath.slug,
        storage.readFileSync(target.communityPath(trackedPath.slug), 'utf-8'),
      );
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
      return capturePrincipleManifestDelta(
        trackedPath.slug,
        storage.readFileSync(target.principlePath(trackedPath.slug), 'utf-8'),
      );
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
    return captureEntityGraphManifestDelta(storage.readFileSync(target.entityGraphPath(), 'utf-8'));
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

  if (trackedPath.kind === 'wiki') {
    mutation.changedEntryIds.push(wikiEntryId(trackedPath.slug));
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

  mutation.changedEntryIds = uniqueSortedStrings(mutation.changedEntryIds);
  return mutation;
}

export function detectInboundSyncMutationFromSurface(
  surface: CorpusSurface,
  manifestAuthority: ManifestAuthority,
  forceFullInstall = false,
): InboundSyncMutationDiff {
  return diffCorpusSurfaceAgainstAuthority(surface, manifestAuthority, { forceFullInstall });
}

type InboundIndexPaths = {
  notePath(note: string): string;
  wikiPath(slug: string): string;
  sourcePath(source: string): string;
  storagePort: Pick<StoragePort, 'readFileSync'>;
};

export function buildInboundSyncIndexDelta(
  startIndex: KbIndex | null,
  changedEntryIds: readonly string[],
  paths: InboundIndexPaths,
): KbIndex {
  const nextIndex = cloneKbIndex(startIndex);

  for (const entryId of changedEntryIds) {
    if (entryId.startsWith('note:')) {
      const slug = entryId.slice('note:'.length);
      const notePath = paths.notePath(slug);

      try {
        const { body, frontmatter, title } = loadKbNote(paths.storagePort, notePath);
        nextIndex.entries[entryId] = buildNoteIndexEntry({
          slug,
          title,
          body,
          ...frontmatter,
        });
      } catch (error: unknown) {
        if (!isNoEntryError(error)) {
          throw error;
        }
        delete nextIndex.entries[entryId];
      }
      continue;
    }

    if (entryId.startsWith('wiki:')) {
      const slug = entryId.slice('wiki:'.length);
      const wikiPath = paths.wikiPath(slug);

      try {
        const raw = paths.storagePort.readFileSync(wikiPath, 'utf-8');
        const frontmatter = parseWikiFrontmatter(raw);
        const body = extractBody(raw);
        const sections = parseWikiBody(body);
        nextIndex.entries[entryId] = buildWikiIndexEntry({
          slug,
          title: extractTitle(raw),
          ...frontmatter,
          knowledge: extractKnowledgeLinks(sections.knowledge),
        });
      } catch (error: unknown) {
        if (!isNoEntryError(error)) {
          throw error;
        }
        delete nextIndex.entries[entryId];
      }
      continue;
    }

    if (entryId.startsWith('source:')) {
      const slug = entryId.slice('source:'.length);
      const sourcePath = paths.sourcePath(slug);

      try {
        const { body, frontmatter } = loadKbSource(paths.storagePort, sourcePath);
        nextIndex.entries[entryId] = buildSourceIndexEntry({
          slug,
          body,
          ...frontmatter,
        });
      } catch (error: unknown) {
        if (!isNoEntryError(error)) {
          throw error;
        }
        delete nextIndex.entries[entryId];
      }
    }
  }

  return nextIndex;
}
