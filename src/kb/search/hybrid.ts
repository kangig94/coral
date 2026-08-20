import type {
  FusedResult,
  FusedRetrievalHit,
  FusionProfile,
  HybridFusion,
  RetrievalEvidence,
  RetrievalHit,
  RoleExecutionResult,
} from './contract.js';

function rrfContribution(rank: number, weight: number, profile: FusionProfile): number {
  return weight / (profile.rrfK + rank);
}

function roleWeight(roleResult: RoleExecutionResult, profile: FusionProfile): number {
  const { descriptor } = roleResult.registeredRole;
  const primaryTag = descriptor.tags[0];
  return (
    profile.overrides.get(descriptor.id) ??
    (primaryTag === undefined ? undefined : profile.classWeights.get(primaryTag)) ??
    1.0
  );
}

function evidence(
  roleResult: RoleExecutionResult,
  hit: RetrievalHit,
  weight: number,
  profile: FusionProfile,
): RetrievalEvidence {
  const contribution = rrfContribution(hit.rank, weight, profile);
  return {
    roleId: roleResult.registeredRole.descriptor.id,
    label: roleResult.registeredRole.descriptor.label,
    rank: hit.rank,
    weight,
    contribution,
    ...(hit.match === undefined ? {} : { match: [...hit.match] }),
  };
}

function compareFusedHits(left: FusedRetrievalHit, right: FusedRetrievalHit): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }
  return left.entryId.localeCompare(right.entryId);
}

class ReciprocalRankFusion implements HybridFusion {
  fuse(roleResults: ReadonlyArray<RoleExecutionResult>, profile: FusionProfile): FusedResult {
    const fused = new Map<FusedRetrievalHit['entryId'], FusedRetrievalHit>();

    for (const roleResult of roleResults) {
      if ('diagnostic' in roleResult) {
        continue;
      }

      const weight = roleWeight(roleResult, profile);
      for (const hit of roleResult.hits) {
        const roleEvidence = evidence(roleResult, hit, weight, profile);
        const previous = fused.get(hit.entryId);
        if (previous === undefined) {
          fused.set(hit.entryId, {
            entryId: hit.entryId,
            slug: hit.slug,
            kind: hit.kind,
            title: hit.title,
            tags: [...hit.tags],
            principles: [...hit.principles],
            rank: 0,
            score: roleEvidence.contribution,
            document: hit.document ?? null,
            evidence: [roleEvidence],
          });
          continue;
        }

        previous.document = previous.document ?? hit.document ?? null;
        previous.score += roleEvidence.contribution;
        previous.evidence.push(roleEvidence);
      }
    }

    const hits = [...fused.values()].sort(compareFusedHits);
    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index];
      if (hit !== undefined) {
        hit.rank = index + 1;
      }
    }

    return {
      hits,
    };
  }
}

export function createHybridFusion(): HybridFusion {
  return new ReciprocalRankFusion();
}
