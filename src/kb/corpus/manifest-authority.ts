import { noteEntryId, sourceEntryId, wikiEntryId } from '../entry-types.js';
import {
  extractBody,
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
  parseWikiBody,
  parseWikiFrontmatter,
} from './frontmatter.js';
import {
  computeContentSurfaceHash,
  computeManifestHash,
  computeMetadataSurfaceHash,
  type CanonicalFrontmatterRecord,
} from './snapshot.js';
import type { ManifestAuthorityDelta, ManifestAuthorityLane } from './manifest-types.js';

export type FullManifestSurfaceHashes = {
  content: Map<string, string>;
  metadata: Map<string, string>;
};

export type StagedManifestSurfaceHashes = {
  readonly commitId: string;
  readonly hashes: FullManifestSurfaceHashes;
  readonly contentManifestHash: string;
  readonly metadataManifestHash: string;
};

export interface ManifestAuthority {
  replaceCurrentSurfaceHashes(hashes: FullManifestSurfaceHashes): void;
  stageCurrentSurfaceHashes(hashes: FullManifestSurfaceHashes, commitId: string): StagedManifestSurfaceHashes;
  adoptStagedSurfaceHashes(staged: StagedManifestSurfaceHashes): void;
  updateFromDelta(deltas: Iterable<ManifestAuthorityDelta>): void;
  getCurrentManifestHash(lane: ManifestAuthorityLane): string;
  getCurrentSurfaceHash(lane: ManifestAuthorityLane, manifestId: string): string | null;
  getCurrentSurfaceHashes(lane: ManifestAuthorityLane): ReadonlyMap<string, string>;
  getCurrentSurfaceCommitId(): string | null;
  reset(): void;
}

export function createManifestAuthority(): ManifestAuthority {
  let contentSurfaceHashes = new Map<string, string>();
  let metadataSurfaceHashes = new Map<string, string>();
  let cachedContentManifestHash: string | null = null;
  let cachedMetadataManifestHash: string | null = null;
  let currentSurfaceCommitId: string | null = null;

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

  function replaceLaneHashes(lane: ManifestAuthorityLane, nextHashes: ReadonlyMap<string, string>): void {
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
    replaceCurrentSurfaceHashes(hashes): void {
      replaceLaneHashes('content', hashes.content);
      replaceLaneHashes('metadata', hashes.metadata);
      currentSurfaceCommitId = null;
    },

    stageCurrentSurfaceHashes(hashes, commitId): StagedManifestSurfaceHashes {
      const content = new Map(hashes.content);
      const metadata = new Map(hashes.metadata);
      return {
        commitId,
        hashes: { content, metadata },
        contentManifestHash: computeManifestHashFromSurfaceHashes(content),
        metadataManifestHash: computeManifestHashFromSurfaceHashes(metadata),
      };
    },

    adoptStagedSurfaceHashes(staged): void {
      contentSurfaceHashes = staged.hashes.content;
      metadataSurfaceHashes = staged.hashes.metadata;
      cachedContentManifestHash = staged.contentManifestHash;
      cachedMetadataManifestHash = staged.metadataManifestHash;
      currentSurfaceCommitId = staged.commitId;
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
          currentSurfaceCommitId = null;
          continue;
        }

        if (previous === delta.surfaceHash) {
          continue;
        }

        target.set(delta.manifestId, delta.surfaceHash);
        invalidateLaneHash(delta.lane);
        currentSurfaceCommitId = null;
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

    getCurrentSurfaceCommitId(): string | null {
      return currentSurfaceCommitId;
    },

    reset(): void {
      contentSurfaceHashes = new Map();
      metadataSurfaceHashes = new Map();
      cachedContentManifestHash = null;
      cachedMetadataManifestHash = null;
      currentSurfaceCommitId = null;
    },
  };
}

export function noteMetadataManifestId(slug: string): string {
  return `note-meta:${slug}`;
}

export function sourceMetadataManifestId(slug: string): string {
  return `source-meta:${slug}`;
}

export function wikiMetadataManifestId(slug: string): string {
  return `wiki-meta:${slug}`;
}

const COMMUNITY_METADATA_MANIFEST_ID_PREFIX = 'community:';

export function communityMetadataManifestId(slug: string): string {
  return `${COMMUNITY_METADATA_MANIFEST_ID_PREFIX}${slug}`;
}

export function isCommunityMetadataManifestId(manifestId: string): boolean {
  return manifestId.startsWith(COMMUNITY_METADATA_MANIFEST_ID_PREFIX);
}

export function communitySlugFromMetadataManifestId(manifestId: string): string | null {
  return isCommunityMetadataManifestId(manifestId)
    ? manifestId.slice(COMMUNITY_METADATA_MANIFEST_ID_PREFIX.length)
    : null;
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

export function captureWikiManifestDeltas(slug: string, raw: string): ManifestAuthorityDelta[] {
  try {
    const metadata = parseWikiFrontmatter(raw);
    const body = extractBody(raw);
    parseWikiBody(body);
    return [
      {
        lane: 'content',
        manifestId: wikiEntryId(slug),
        surfaceHash: computeContentSurfaceHash({
          title: extractTitle(raw),
          body,
        }),
      },
      {
        lane: 'metadata',
        manifestId: wikiMetadataManifestId(slug),
        surfaceHash: computeMetadataSurfaceHash({
          // KbWikiFrontmatter satisfies CanonicalFrontmatterRecord structurally; cast avoids widening the metadata-hash input type.
          frontmatter: metadata as unknown as CanonicalFrontmatterRecord,
        }),
      },
    ];
  } catch {
    return [
      {
        lane: 'content',
        manifestId: wikiEntryId(slug),
        surfaceHash: null,
      },
      {
        lane: 'metadata',
        manifestId: wikiMetadataManifestId(slug),
        surfaceHash: null,
      },
    ];
  }
}

export function captureRemovedWikiManifestDeltas(slug: string): ManifestAuthorityDelta[] {
  return [
    {
      lane: 'content',
      manifestId: wikiEntryId(slug),
      surfaceHash: null,
    },
    {
      lane: 'metadata',
      manifestId: wikiMetadataManifestId(slug),
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

export function computeManifestHashFromSurfaceHashes(hashes: ReadonlyMap<string, string>): string {
  const entries: Array<{ manifestId: string; surfaceHash: string }> = [];
  for (const [manifestId, surfaceHash] of hashes) {
    entries.push({
      manifestId,
      surfaceHash,
    });
  }
  return computeManifestHash(entries);
}

function surfaceHashMapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [manifestId, surfaceHash] of left) {
    if (right.get(manifestId) !== surfaceHash) {
      return false;
    }
  }
  return true;
}
