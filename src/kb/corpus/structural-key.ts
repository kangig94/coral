import { sha256Hex } from '../../infra/hash.js';
import type { EntityGraph, KbIndex } from '../entry-types.js';
import {
  communityMetadataManifestId,
  communitySlugFromMetadataManifestId,
  computeManifestHashFromSurfaceHashes,
  entityGraphMetadataManifestId,
  type ManifestAuthority,
} from './manifest-authority.js';
import { computeMetadataSurfaceHash } from './snapshot.js';
import type { GeneratedCommunityFreshness } from '../curate/community/generated-projection-store.js';

export type CorpusStructuralKey = {
  readonly entityGraphHash: string;
  readonly communityDocsHash: string;
};

type CorpusStructuralKeyAuthority = Pick<ManifestAuthority, 'getCurrentSurfaceHash' | 'getCurrentSurfaceHashes'>;

type RawCommunityDocument = {
  readonly slug: string;
  readonly raw: string;
};

export function corpusStructuralCacheKey(key: CorpusStructuralKey): string {
  return `${key.entityGraphHash}\u0000${key.communityDocsHash}`;
}

function combineAuthoredAndGeneratedCommunityDocsHash(
  authoredCommunityDocsHash: string,
  generatedCommunityFreshness: GeneratedCommunityFreshness,
): string {
  return computeManifestHashFromSurfaceHashes(
    new Map([
      ['authored-community-docs', authoredCommunityDocsHash],
      ['generated-community-docs', generatedCommunityFreshness.generatedCommunityDocsHash],
    ]),
  );
}

export function computeCommunityDocsHashFromSurfaceHashes(
  metadataHashes: ReadonlyMap<string, string>,
  generatedCommunityFreshness: GeneratedCommunityFreshness,
  generatedCommunitySlugs: ReadonlySet<string> = new Set(),
): string {
  const communityHashes = new Map<string, string>();
  for (const [manifestId, surfaceHash] of metadataHashes) {
    const slug = communitySlugFromMetadataManifestId(manifestId);
    if (slug !== null && !generatedCommunitySlugs.has(slug)) {
      communityHashes.set(manifestId, surfaceHash);
    }
  }
  return combineAuthoredAndGeneratedCommunityDocsHash(
    computeManifestHashFromSurfaceHashes(communityHashes),
    generatedCommunityFreshness,
  );
}

function computeCommunityDocsHashFromRawDocuments(
  documents: Iterable<RawCommunityDocument>,
  generatedCommunityFreshness: GeneratedCommunityFreshness,
  generatedCommunitySlugs: ReadonlySet<string> = new Set(),
): string {
  const communityHashes = new Map<string, string>();
  for (const document of documents) {
    if (generatedCommunitySlugs.has(document.slug)) {
      continue;
    }
    communityHashes.set(
      communityMetadataManifestId(document.slug),
      computeMetadataSurfaceHash({
        rawBytes: document.raw,
      }),
    );
  }
  return combineAuthoredAndGeneratedCommunityDocsHash(
    computeManifestHashFromSurfaceHashes(communityHashes),
    generatedCommunityFreshness,
  );
}

export function createCorpusStructuralKeyFromRawSurfaces(input: {
  readonly entityGraphRaw: string | null;
  readonly communityDocuments: Iterable<RawCommunityDocument>;
  readonly generatedCommunityFreshness: GeneratedCommunityFreshness;
  readonly generatedCommunitySlugs?: ReadonlySet<string>;
}): CorpusStructuralKey | undefined {
  if (input.entityGraphRaw === null) {
    return undefined;
  }

  return {
    entityGraphHash: computeMetadataSurfaceHash({
      rawBytes: input.entityGraphRaw,
    }),
    communityDocsHash: computeCommunityDocsHashFromRawDocuments(
      input.communityDocuments,
      input.generatedCommunityFreshness,
      input.generatedCommunitySlugs,
    ),
  };
}

function readCurrentCorpusStructuralKey(
  authority: CorpusStructuralKeyAuthority,
  generatedCommunityFreshness: GeneratedCommunityFreshness,
  generatedCommunitySlugs: ReadonlySet<string> = new Set(),
): CorpusStructuralKey | null {
  const entityGraphHash = authority.getCurrentSurfaceHash('metadata', entityGraphMetadataManifestId());
  if (entityGraphHash === null) {
    return null;
  }

  return {
    entityGraphHash,
    communityDocsHash: computeCommunityDocsHashFromSurfaceHashes(
      authority.getCurrentSurfaceHashes('metadata'),
      generatedCommunityFreshness,
      generatedCommunitySlugs,
    ),
  };
}

export function resolveCorpusStructuralKey(input: {
  readonly index: KbIndex;
  readonly manifestAuthority: CorpusStructuralKeyAuthority;
  readonly generatedCommunityFreshness: GeneratedCommunityFreshness;
  readonly generatedCommunitySlugs?: ReadonlySet<string>;
  readonly currentGraph?: EntityGraph | null;
  readonly readCurrentGraph?: () => EntityGraph | null;
}): CorpusStructuralKey | null {
  const currentKey = readCurrentCorpusStructuralKey(
    input.manifestAuthority,
    input.generatedCommunityFreshness,
    input.generatedCommunitySlugs,
  );
  if (currentKey === null || Object.keys(input.index.entityMeta).length === 0) {
    return null;
  }

  if (input.index.structuralKey?.entityGraphHash === currentKey.entityGraphHash) {
    return currentKey;
  }

  const currentGraph =
    input.currentGraph !== undefined ? input.currentGraph : (input.readCurrentGraph?.() ?? undefined);
  if (currentGraph === undefined || currentGraph === null || Object.keys(currentGraph.entityMeta).length === 0) {
    return null;
  }

  return entityGraphMatchesIndex(input.index, currentGraph) ? currentKey : null;
}

function entityGraphMatchesIndex(index: Pick<KbIndex, 'entityMeta' | 'relationships'>, graph: EntityGraph): boolean {
  return (
    computeEntityGraphSemanticHash({
      entityMeta: index.entityMeta,
      relationships: index.relationships,
    }) === computeEntityGraphSemanticHash(graph)
  );
}

function computeEntityGraphSemanticHash(graph: EntityGraph): string {
  return sha256Hex(JSON.stringify(stableEntityGraph(graph)));
}

function stableEntityGraph(graph: EntityGraph): EntityGraph {
  const entityMetaEntries = Object.entries(graph.entityMeta).sort(([left], [right]) => left.localeCompare(right));
  const entityMeta: EntityGraph['entityMeta'] = {};
  for (const [entityName, meta] of entityMetaEntries) {
    entityMeta[entityName] = {
      type: meta.type,
      description: meta.description,
      ...(meta.aliases === undefined ? {} : { aliases: sortedUniqueStrings(meta.aliases) }),
    };
  }

  const relationships: EntityGraph['relationships'] = [];
  for (const relationship of graph.relationships) {
    relationships.push({
      source: relationship.source,
      target: relationship.target,
      type: relationship.type,
      description: relationship.description,
      evidence: sortedUniqueStrings(relationship.evidence),
    });
  }
  relationships.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target) ||
      left.type.localeCompare(right.type) ||
      left.description.localeCompare(right.description),
  );

  return {
    entityMeta,
    relationships,
  };
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique.sort((left, right) => left.localeCompare(right));
}
