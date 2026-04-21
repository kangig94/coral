import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNoEntryError } from '../../shared/utils.js';
import type { KbRuntime } from '../contracts.js';
import { noteEntryId, sourceEntryId } from '../entry-types.js';
import { stripMdExt } from '../paths.js';
import {
  extractBody,
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
} from './frontmatter.js';
import { sortedMarkdownEntries } from './markdown-entries.js';
import {
  computeContentSurfaceHash,
  computeManifestHash,
  computeMetadataSurfaceHash,
  type CanonicalFrontmatterRecord,
} from './snapshot.js';

export type ManifestAuthorityLane = 'content' | 'metadata';

export type ManifestAuthorityDelta = {
  lane: ManifestAuthorityLane;
  manifestId: string;
  surfaceHash: string | null;
};

export type FullManifestSurfaceHashes = {
  content: Map<string, string>;
  metadata: Map<string, string>;
};

type ManifestAuthorityTarget = Pick<
  KbRuntime,
  'notesDir' | 'sourcesDir' | 'communitiesDir' | 'principlesDir' | 'entityGraphPath'
>;

export interface ManifestAuthority {
  seedFromFullCollectors(target: ManifestAuthorityTarget): void;
  replaceCurrentSurfaceHashes(hashes: FullManifestSurfaceHashes): void;
  updateFromDelta(deltas: Iterable<ManifestAuthorityDelta>): void;
  getCurrentManifestHash(lane: ManifestAuthorityLane): string;
  getCurrentSurfaceHash(lane: ManifestAuthorityLane, manifestId: string): string | null;
  getCurrentSurfaceHashes(lane: ManifestAuthorityLane): ReadonlyMap<string, string>;
  reset(): void;
}

export function createManifestAuthority(): ManifestAuthority {
  let contentSurfaceHashes = new Map<string, string>();
  let metadataSurfaceHashes = new Map<string, string>();
  let cachedContentManifestHash: string | null = null;
  let cachedMetadataManifestHash: string | null = null;

  function mapForLane(lane: ManifestAuthorityLane): Map<string, string> {
    return lane === 'content' ? contentSurfaceHashes : metadataSurfaceHashes;
  }

  function invalidateLaneHash(lane: ManifestAuthorityLane): void {
    // Manifest hash is recomputed lazily on next getCurrentManifestHash; invalidating on any write avoids stale reads without paying re-derivation cost on hot writes.
    if (lane === 'content') {
      cachedContentManifestHash = null;
      return;
    }
    cachedMetadataManifestHash = null;
  }

  function replaceLaneHashes(
    lane: ManifestAuthorityLane,
    nextHashes: ReadonlyMap<string, string>,
  ): void {
    const nextMap = new Map(nextHashes);
    if (!surfaceHashMapsEqual(mapForLane(lane), nextMap)) {
      if (lane === 'content') {
        contentSurfaceHashes = nextMap;
      } else {
        metadataSurfaceHashes = nextMap;
      }
      invalidateLaneHash(lane);
    }
  }

  return {
    seedFromFullCollectors(target): void {
      this.replaceCurrentSurfaceHashes(collectFullManifestSurfaceHashes(target));
    },

    replaceCurrentSurfaceHashes(hashes): void {
      replaceLaneHashes('content', hashes.content);
      replaceLaneHashes('metadata', hashes.metadata);
    },

    updateFromDelta(deltas): void {
      for (const delta of deltas) {
        const target = mapForLane(delta.lane);
        const previous = target.get(delta.manifestId);
        if (delta.surfaceHash === null) {
          if (!target.has(delta.manifestId)) {
            continue;
          }
          target.delete(delta.manifestId);
          invalidateLaneHash(delta.lane);
          continue;
        }

        if (previous === delta.surfaceHash) {
          continue;
        }

        target.set(delta.manifestId, delta.surfaceHash);
        invalidateLaneHash(delta.lane);
      }
    },

    getCurrentManifestHash(lane): string {
      if (lane === 'content') {
        cachedContentManifestHash ??= computeManifestHashFromSurfaceHashes(contentSurfaceHashes);
        return cachedContentManifestHash;
      }

      cachedMetadataManifestHash ??= computeManifestHashFromSurfaceHashes(metadataSurfaceHashes);
      return cachedMetadataManifestHash;
    },

    getCurrentSurfaceHash(lane, manifestId): string | null {
      return mapForLane(lane).get(manifestId) ?? null;
    },

    getCurrentSurfaceHashes(lane): ReadonlyMap<string, string> {
      return new Map(mapForLane(lane));
    },

    reset(): void {
      contentSurfaceHashes = new Map();
      metadataSurfaceHashes = new Map();
      cachedContentManifestHash = null;
      cachedMetadataManifestHash = null;
    },
  };
}

export function noteMetadataManifestId(slug: string): string {
  return `note-meta:${slug}`;
}

export function sourceMetadataManifestId(slug: string): string {
  return `source-meta:${slug}`;
}

export function communityMetadataManifestId(slug: string): string {
  return `community:${slug}`;
}

export function principleMetadataManifestId(slug: string): string {
  return `principle:${slug}`;
}

export function entityGraphMetadataManifestId(): string {
  return 'entity-graph:.entity-graph.json';
}

export function captureNoteManifestDeltas(slug: string, raw: string): ManifestAuthorityDelta[] {
  const deltas: ManifestAuthorityDelta[] = [
    {
      lane: 'content',
      manifestId: noteEntryId(slug),
      surfaceHash: computeContentSurfaceHash({
        title: extractTitle(raw),
        body: extractBody(raw),
      }),
    },
  ];

  try {
    deltas.push({
      lane: 'metadata',
      manifestId: noteMetadataManifestId(slug),
      surfaceHash: computeMetadataSurfaceHash({
        // KbNoteFrontmatter satisfies CanonicalFrontmatterRecord structurally; cast avoids widening the metadata-hash input type.
        frontmatter: parseFrontmatter(raw) as unknown as CanonicalFrontmatterRecord,
      }),
    });
  } catch {
    deltas.push({
      lane: 'metadata',
      manifestId: noteMetadataManifestId(slug),
      surfaceHash: null,
    });
  }

  return deltas;
}

export function captureRemovedNoteManifestDeltas(slug: string): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'content',
      manifestId: noteEntryId(slug),
      surfaceHash: null,
    },
    {
      lane: 'metadata',
      manifestId: noteMetadataManifestId(slug),
      surfaceHash: null,
    },
  ];
}

export function captureSourceManifestDeltas(slug: string, raw: string): ManifestAuthorityDelta[] {
  try {
    const { title, ...metadata } = parseSourceFrontmatter(raw);
    return [
      {
        lane: 'content',
        manifestId: sourceEntryId(slug),
        surfaceHash: computeContentSurfaceHash({
          title,
          body: extractBody(raw),
        }),
      },
      {
        lane: 'metadata',
        manifestId: sourceMetadataManifestId(slug),
        surfaceHash: computeMetadataSurfaceHash({
          // KbSourceFrontmatter satisfies CanonicalFrontmatterRecord structurally; cast avoids widening the metadata-hash input type.
          frontmatter: metadata as unknown as CanonicalFrontmatterRecord,
        }),
      },
    ];
  } catch {
    return [
      {
        lane: 'content',
        manifestId: sourceEntryId(slug),
        surfaceHash: null,
      },
      {
        lane: 'metadata',
        manifestId: sourceMetadataManifestId(slug),
        surfaceHash: null,
      },
    ];
  }
}

export function captureRemovedSourceManifestDeltas(slug: string): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'content',
      manifestId: sourceEntryId(slug),
      surfaceHash: null,
    },
    {
      lane: 'metadata',
      manifestId: sourceMetadataManifestId(slug),
      surfaceHash: null,
    },
  ];
}

export function captureCommunityManifestDelta(slug: string, raw: string): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'metadata',
      manifestId: communityMetadataManifestId(slug),
      surfaceHash: computeMetadataSurfaceHash({
        rawBytes: raw,
      }),
    },
  ];
}

export function captureRemovedCommunityManifestDelta(slug: string): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'metadata',
      manifestId: communityMetadataManifestId(slug),
      surfaceHash: null,
    },
  ];
}

export function capturePrincipleManifestDelta(slug: string, raw: string): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'metadata',
      manifestId: principleMetadataManifestId(slug),
      surfaceHash: computeMetadataSurfaceHash({
        rawBytes: raw,
      }),
    },
  ];
}

export function captureRemovedPrincipleManifestDelta(slug: string): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'metadata',
      manifestId: principleMetadataManifestId(slug),
      surfaceHash: null,
    },
  ];
}

export function captureEntityGraphManifestDelta(raw: string | null): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'metadata',
      manifestId: entityGraphMetadataManifestId(),
      surfaceHash:
        raw === null
          ? null
          : computeMetadataSurfaceHash({
              rawBytes: raw,
            }),
    },
  ];
}

export function collectFullManifestSurfaceHashes(target: ManifestAuthorityTarget): FullManifestSurfaceHashes {
  const content = new Map<string, string>();
  const metadata = new Map<string, string>();

  for (const entry of sortedMarkdownEntries(target.notesDir())) {
    const slug = stripMdExt(entry);
    const raw = readFileSync(join(target.notesDir(), entry), 'utf-8');
    applyDeltasToSurfaceHashes(content, metadata, captureNoteManifestDeltas(slug, raw));
  }

  for (const entry of sortedMarkdownEntries(target.sourcesDir())) {
    const slug = stripMdExt(entry);
    const raw = readFileSync(join(target.sourcesDir(), entry), 'utf-8');
    applyDeltasToSurfaceHashes(content, metadata, captureSourceManifestDeltas(slug, raw));
  }

  for (const entry of sortedMarkdownEntries(target.communitiesDir())) {
    const slug = stripMdExt(entry);
    applyDeltasToSurfaceHashes(
      content,
      metadata,
      captureCommunityManifestDelta(slug, readFileSync(join(target.communitiesDir(), entry), 'utf-8')),
    );
  }

  for (const entry of sortedMarkdownEntries(target.principlesDir())) {
    const slug = stripMdExt(entry);
    applyDeltasToSurfaceHashes(
      content,
      metadata,
      capturePrincipleManifestDelta(slug, readFileSync(join(target.principlesDir(), entry), 'utf-8')),
    );
  }

  try {
    applyDeltasToSurfaceHashes(
      content,
      metadata,
      captureEntityGraphManifestDelta(readFileSync(target.entityGraphPath(), 'utf-8')),
    );
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      throw error;
    }
  }

  return { content, metadata };
}

export function computeFullCollectorManifestHash(
  target: ManifestAuthorityTarget,
  lane: ManifestAuthorityLane,
): string {
  const hashes = collectFullManifestSurfaceHashes(target);
  return computeManifestHashFromSurfaceHashes(hashes[lane]);
}

export function computeManifestHashFromSurfaceHashes(hashes: ReadonlyMap<string, string>): string {
  return computeManifestHash(
    [...hashes.entries()].map(([manifestId, surfaceHash]) => ({
      manifestId,
      surfaceHash,
    })),
  );
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

function surfaceHashMapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left.entries()].every(([manifestId, surfaceHash]) => right.get(manifestId) === surfaceHash)
  );
}
