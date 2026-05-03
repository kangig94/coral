import { describe, expect, it } from 'vitest';

import { defaultFusionProfile } from '#src/kb/search/default-fusion-profile.js';
import { createHybridFusion } from '#src/kb/search/hybrid.js';
import type {
  FusionProfile,
  RegisteredRetrievalRole,
  RetrievalHit,
  RetrievalRoleDescriptor,
  RoleExecutionResult,
} from '#src/kb/search/contract.js';

function hit(entryId: `note:${string}` = 'note:profile-target'): RetrievalHit {
  const slug = entryId.slice('note:'.length);
  return {
    entryId,
    slug,
    kind: 'note',
    title: slug,
    tags: [],
    principles: [],
    rank: 1,
    score: 1,
  };
}

function result(id: string, tags: readonly string[], profileHit: RetrievalHit = hit()): RoleExecutionResult {
  const descriptor: RetrievalRoleDescriptor = {
    id,
    label: id,
    tags: [...tags],
    phase: 'retrieval-source',
    supportsScopes: ['notes', 'sources', 'communities', 'all'],
    provides: 'retrieval-source',
  };
  const registeredRole: RegisteredRetrievalRole = {
    role: {
      id,
      descriptor,
      async search() {
        return { hits: [] };
      },
    },
    descriptor,
    origin: 'external',
    permanence: 'scoped',
  };
  return { registeredRole, hits: [profileHit] };
}

describe('fusion profile precedence', () => {
  it('lets the graph override beat the structural class default while external structural roles use the default', () => {
    const fused = createHybridFusion().fuse(
      [
        result('graph', ['structural'], hit('note:graph')),
        result('external-structural', ['structural'], hit('note:external')),
      ],
      defaultFusionProfile,
    );

    expect(fused.hits.map((item) => [item.entryId, item.score])).toEqual([
      ['note:external', 1 / 61],
      ['note:graph', 0.22 / 61],
    ]);
    expect(fused.hits.find((item) => item.entryId === 'note:graph')?.evidence[0]?.weight).toBe(0.22);
    expect(fused.hits.find((item) => item.entryId === 'note:external')?.evidence[0]?.weight).toBe(1);
  });

  it('falls back to weight 1.0 when descriptor.tags is empty and no override exists', () => {
    const fused = createHybridFusion().fuse([result('untagged', [])], defaultFusionProfile);

    expect(fused.hits[0]?.score).toBe(1 / 61);
    expect(fused.hits[0]?.evidence[0]).toMatchObject({
      roleId: 'untagged',
      weight: 1,
      contribution: 1 / 61,
    });
  });

  it('calibrates multi-tag descriptors from tags[0] only', () => {
    const profile: FusionProfile = {
      classWeights: new Map<string, number>([
        ['structural', 0.4],
        ['semantic', 2.0],
      ]),
      overrides: new Map(),
      rrfK: 60,
    };
    const fused = createHybridFusion().fuse([result('multi-tag', ['structural', 'semantic'])], profile);

    expect(fused.hits[0]?.score).toBe(0.4 / 61);
    expect(fused.hits[0]?.evidence[0]).toMatchObject({
      roleId: 'multi-tag',
      weight: 0.4,
      contribution: 0.4 / 61,
    });
  });
});
