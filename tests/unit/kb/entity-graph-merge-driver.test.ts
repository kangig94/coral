import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEntityGraph } from '#src/kb/corpus/entity-graph-store.js';
import {
  consolidateCanonicalEntityGraph,
  mergeEntityGraphRevisions,
  runEntityGraphMergeDriver,
} from '#src/kb/curate/entity-graph-merge-driver.js';
import { type EntityGraph } from '#src/kb/entry-types.js';

function graphBytes(graph: EntityGraph): string {
  return renderEntityGraph(graph);
}

describe('entity graph merge driver', () => {
  let roots: string[] = [];
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    roots = [];
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
  });

  it('writes a byte-identical consolidated ours/theirs merge, ignores base, and emits no conflict markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-entity-graph-driver-'));
    roots.push(root);
    const basePath = join(root, 'base.json');
    const oursPath = join(root, 'ours.json');
    const theirsPath = join(root, 'theirs.json');
    const originalOursPath = join(root, 'original-ours.json');
    const reverseOursPath = join(root, 'reverse-ours.json');

    const base: EntityGraph = {
      entityMeta: {
        'base-only': {
          type: 'concept',
          description: 'Base-only entity that consolidation previously dropped.',
        },
      },
      relationships: [],
    };
    const ours: EntityGraph = {
      entityMeta: {
        'graph-rag': {
          type: 'concept',
          description: 'Graph-backed retrieval.',
          aliases: ['graphrag'],
        },
        retrieval: {
          type: 'operation',
          description: 'Retrieval workflows.',
        },
      },
      relationships: [
        {
          source: 'graph-rag',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph structure helps retrieval.',
          evidence: ['note:ours'],
        },
      ],
    };
    const theirs: EntityGraph = {
      entityMeta: {
        'graph-rag': {
          type: 'concept',
          description: 'Graph-backed retrieval for knowledge-base search.',
          aliases: ['graph-retrieval'],
        },
        retrieval: {
          type: 'operation',
          description: 'Retrieval workflows.',
        },
      },
      relationships: [
        {
          source: 'graph-retrieval',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph retrieval helps retrieval.',
          evidence: ['note:theirs'],
        },
      ],
    };

    writeFileSync(basePath, renderEntityGraph(base), 'utf-8');
    writeFileSync(oursPath, renderEntityGraph(ours), 'utf-8');
    writeFileSync(theirsPath, renderEntityGraph(theirs), 'utf-8');
    writeFileSync(originalOursPath, renderEntityGraph(ours), 'utf-8');
    writeFileSync(reverseOursPath, renderEntityGraph(theirs), 'utf-8');

    const host = { readFileSync, writeFileSync };
    runEntityGraphMergeDriver({ basePath, oursPath, theirsPath }, host);
    runEntityGraphMergeDriver({ basePath, oursPath: reverseOursPath, theirsPath: originalOursPath }, host);

    const expected = renderEntityGraph(mergeEntityGraphRevisions(ours, theirs));
    const mergedRaw = readFileSync(oursPath, 'utf-8');
    expect(mergedRaw).toBe(expected);
    expect(readFileSync(reverseOursPath, 'utf-8')).toBe(expected);
    expect(mergedRaw).not.toContain('<<<<<<<');
    expect(mergedRaw).not.toContain('base-only');
    expect(graphBytes(consolidateCanonicalEntityGraph(JSON.parse(mergedRaw) as EntityGraph))).toBe(mergedRaw);
  });
});
