import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendLog } from '../../shared/backend-log.js';
import { createKbRuntime } from '../runtime.js';
import type { EntityGraph } from '../entry-types.js';

function createGraph(): EntityGraph {
  return {
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
        evidence: ['note:graph-rag'],
      },
    ],
  };
}

describe('entity-graph', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads valid graphs and treats missing files as unavailable without warnings', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kb-entity-graph-'));
    const kb = createKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
    });
    const warnSpy = vi.spyOn(backendLog, 'warn');

    expect(kb.readEntityGraph()).toBeNull();

    const graph = createGraph();
    writeFileSync(kb.entityGraphPath(), `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

    expect(kb.readEntityGraph()).toEqual(graph);
    expect(warnSpy).not.toHaveBeenCalled();

    rmSync(root, { recursive: true, force: true });
  });

  it('degrades on malformed, invalid, and conflict-marked files without rewriting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kb-entity-graph-'));
    const kb = createKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
    });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    const malformed = '{';
    writeFileSync(kb.entityGraphPath(), malformed, 'utf-8');
    expect(kb.readEntityGraph()).toBeNull();
    expect(readFileSync(kb.entityGraphPath(), 'utf-8')).toBe(malformed);

    const invalidGraph = JSON.stringify({
      entityMeta: {
        'graph-rag': {
          type: 'not-a-real-type',
          description: 'Bad type.',
        },
      },
      relationships: [],
    });
    writeFileSync(kb.entityGraphPath(), invalidGraph, 'utf-8');
    expect(kb.readEntityGraph()).toBeNull();
    expect(readFileSync(kb.entityGraphPath(), 'utf-8')).toBe(invalidGraph);

    const conflicted = `<<<<<<< HEAD
{"entityMeta":{},"relationships":[]}
=======
{"entityMeta":{"graph-rag":{"type":"concept","description":"Graph-backed retrieval."}},"relationships":[]}
>>>>>>> incoming
`;
    writeFileSync(kb.entityGraphPath(), conflicted, 'utf-8');
    expect(kb.readEntityGraph()).toBeNull();
    expect(readFileSync(kb.entityGraphPath(), 'utf-8')).toBe(conflicted);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[2]?.[0]).toContain('graph and community-derived features are disabled');

    rmSync(root, { recursive: true, force: true });
  });

  it('writes graphs atomically through a tmp file and updates the live index copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kb-entity-graph-'));
    const kb = createKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
    });

    kb.writeIndex({
      entries: {},
      principles: {},
    });

    const graph = createGraph();
    kb.writeEntityGraph(graph);

    expect(kb.readEntityGraph()).toEqual(graph);
    expect(kb.readIndex()).toMatchObject({
      entries: {},
      principles: {},
      entityMeta: graph.entityMeta,
      relationships: graph.relationships,
    });
    // Atomic write: the final file exists and no leftover .tmp files remain.
    expect(existsSync(kb.entityGraphPath())).toBe(true);
    const tmpFiles = readdirSync(root).filter(
      (entry) => entry.startsWith('entity-graph.json.') && entry.endsWith('.tmp'),
    );
    expect(tmpFiles).toEqual([]);

    rmSync(root, { recursive: true, force: true });
  });

  it('loads legacy index snapshots that do not contain entity graph fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kb-entity-graph-'));
    const kb = createKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
    });

    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify(
        {
          entries: {
            'note:legacy-note': {
              kind: 'note',
              slug: 'legacy-note',
              title: 'Legacy Note',
              tags: ['legacy-tag'],
              principles: [],
              source: ['kangig94/coral'],
              createdAt: '2026-04-01',
              updatedAt: '2026-04-01',
              related: [],
              entrySeq: 1,
            },
          },
          principles: {},
        },
        null,
        2,
      ),
      'utf-8',
    );

    expect(kb.readIndex()).toEqual({
      entries: {
        'note:legacy-note': {
          kind: 'note',
          slug: 'legacy-note',
          title: 'Legacy Note',
          tags: ['legacy-tag'],
          principles: [],
          source: ['kangig94/coral'],
          createdAt: '2026-04-01',
          updatedAt: '2026-04-01',
          related: [],
          entrySeq: 1,
        },
      },
      principles: {},
    });

    rmSync(root, { recursive: true, force: true });
  });
});
