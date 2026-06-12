import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityGraph } from '#src/kb/entry-types.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type DetectionModule = typeof import('#src/kb/curate/community/detection.js');
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type GraphModule = typeof import('#src/kb/curate/community/graph.js');
type LouvainDetailed = () => {
  communities: Record<string, number>;
  modularity: number;
  dendrogram: ArrayLike<number>[];
};

const backendLogMock = vi.hoisted(() => ({
  init: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  raw: vi.fn(),
  lastLineFor: vi.fn(),
}));

vi.mock('#src/infra/backend-log.js', () => ({
  backendLog: backendLogMock,
}));

async function loadCommunityModules(mockDetailed: LouvainDetailed): Promise<DetectionModule & GraphModule> {
  vi.resetModules();
  vi.doMock('graphology-communities-louvain', () => ({
    default: {
      detailed: mockDetailed,
    },
  }));

  const [detection, graph] = await Promise.all([
    import('#src/kb/curate/community/detection.js'),
    import('#src/kb/curate/community/graph.js'),
  ]);
  return { ...detection, ...graph };
}

function createEntityGraph(nodeCount: number): EntityGraph {
  const entityMeta: EntityGraph['entityMeta'] = {};
  for (let index = 0; index < nodeCount; index += 1) {
    entityMeta[`entity-${index}`] = {
      type: 'concept',
      description: `Entity ${index}.`,
    };
  }

  return {
    entityMeta,
    relationships: [],
  };
}

afterEach(() => {
  backendLogMock.warn.mockReset();
  vi.resetModules();
  vi.unmock('graphology-communities-louvain');
});

describe('community detection Louvain caps', () => {
  it('skips oversized graphs and warns instead of invoking Louvain', async () => {
    let louvainCalls = 0;
    const modules = await loadCommunityModules(() => {
      louvainCalls += 1;
      return {
        communities: {},
        modularity: 0,
        dendrogram: [],
      };
    });
    const nodeCount = modules.COMMUNITY_LOUVAIN_NODE_CAP + 1;
    const graph = modules.buildEntityRelationshipGraph(createEntityGraph(nodeCount));

    expect(modules.detectCommunities(graph)).toEqual([]);

    expect(louvainCalls).toBe(0);
    expect(backendLogMock.warn).toHaveBeenCalledTimes(1);
    expect(backendLogMock.warn).toHaveBeenCalledWith(
      expect.stringContaining(`nodes=${nodeCount} capped at ${modules.COMMUNITY_LOUVAIN_NODE_CAP}`),
    );
  });
});
