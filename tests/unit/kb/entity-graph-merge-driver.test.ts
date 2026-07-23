import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '#src/cli/program.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { readEntityGraphFile, renderEntityGraph } from '#src/kb/corpus/entity-graph-store.js';
import {
  buildCanonicalEntityGraphMergeDelta,
  canonicalSortEntityGraph,
  consolidateCanonicalEntityGraph,
  mergeEntityGraphRevisions,
  runEntityGraphMergeDriver,
} from '#src/kb/curate/entity-graph-merge-driver.js';
import { consolidateEntityGraph } from '#src/kb/curate/entity-consolidation.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  type EntityGraph,
  type EntityType,
  type RelationshipType,
} from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const REPO_ROOT = process.cwd();
const CORPUS_GRAPH_FIXTURE = join(
  REPO_ROOT,
  'tests/unit/kb/corpus/rescan/fixtures/reference-integrity-orphan-entity-graph-refs/.entity-graph.json',
);

function emptyGraph(): EntityGraph {
  return {
    entityMeta: {},
    relationships: [],
  };
}

function graphBytes(graph: EntityGraph): string {
  return renderEntityGraph(graph);
}

function readGraphFixture(path: string): EntityGraph {
  const graph = readEntityGraphFile(
    {
      readFileSync: (filePath: string) => readFileSync(filePath, 'utf-8'),
    },
    path,
  );
  if (graph === null) {
    throw new Error(`Expected valid entity graph fixture: ${path}`);
  }
  return graph;
}

function prefixCollapseRiskGraph(): EntityGraph {
  return {
    entityMeta: {
      api: {
        type: 'concept',
        description: 'API surface.',
      },
      'api-client': {
        type: 'component',
        description: 'Client API component.',
        aliases: ['api-gateway'],
      },
      'api-gateway': {
        type: 'component',
        description: 'Gateway API component.',
      },
    },
    relationships: [],
  };
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)];
}

function generatedGraph(seed: number): EntityGraph {
  const rng = makeRng(seed);
  const prefixes = ['api', 'graph', 'cache', 'queue', 'runtime', 'index', 'worker', 'event'];
  const suffixes = ['client', 'gateway', 'store', 'adapter', 'pipeline', 'service', 'runtime', 'model'];
  const entityMeta: EntityGraph['entityMeta'] = {};

  for (let index = 0; index < 7; index += 1) {
    const prefix = pick(rng, prefixes);
    const suffix = pick(rng, suffixes);
    const singleSegment = rng() < 0.2;
    const name = singleSegment ? prefix : `${prefix}-${suffix}`;
    const aliases = rng() < 0.35 && !singleSegment ? [prefix] : [];
    if (rng() < 0.25 && !singleSegment) {
      aliases.push(`${prefix}-${pick(rng, suffixes)}`);
    }

    entityMeta[name] = {
      type: pick<EntityType>(rng, ENTITY_TYPES),
      description: `${name} description ${seed}-${index}.`,
      ...(aliases.length === 0 ? {} : { aliases }),
    };
  }

  const names = Object.keys(entityMeta).sort();
  const relationships: EntityGraph['relationships'] = [];
  for (let index = 0; index < Math.max(0, names.length - 1); index += 1) {
    const source = names[index];
    const target = names[(index + 1) % names.length];
    if (source === target) {
      continue;
    }
    relationships.push({
      source,
      target,
      type: pick<RelationshipType>(rng, RELATIONSHIP_TYPES),
      description: `${source} relates to ${target}.`,
      evidence: [`note:generated-${seed}-${index}`, `note:generated-${seed}-${index}`],
    });
  }

  return {
    entityMeta,
    relationships,
  };
}

function corpusGraphs(): EntityGraph[] {
  const graphs = [readGraphFixture(CORPUS_GRAPH_FIXTURE)];
  const configuredKbPath = process.env.CORAL_KB_PATH;
  if (configuredKbPath !== undefined) {
    const configuredGraphPath = join(configuredKbPath, '.entity-graph.json');
    if (existsSync(configuredGraphPath)) {
      graphs.push(readGraphFixture(configuredGraphPath));
    }
  }
  return graphs;
}

async function runCli(program: Command, args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  let stdout = '';
  let stderr = '';
  const originalArgv = [...process.argv];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write);

  try {
    process.exitCode = undefined;
    process.argv = ['node', 'coral-cli', ...args];
    await program.parseAsync(process.argv);
    return {
      stdout,
      stderr,
      status: process.exitCode ?? 0,
    };
  } finally {
    process.argv = originalArgv;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = undefined;
  }
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
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
  });

  it('passes the idempotence and order-independence gate over corpus fixtures and generated graphs', () => {
    const generatedGraphs: EntityGraph[] = [prefixCollapseRiskGraph()];
    for (let seed = 1; seed <= 60; seed += 1) {
      generatedGraphs.push(generatedGraph(seed));
    }
    const graphs = [...corpusGraphs(), ...generatedGraphs];

    for (const graph of graphs) {
      const consolidated = consolidateEntityGraph(canonicalSortEntityGraph(graph)).canonicalGraph;
      const secondPass = consolidateEntityGraph(consolidated).canonicalGraph;
      expect(graphBytes(secondPass)).toBe(graphBytes(consolidated));
    }

    for (let index = 0; index < graphs.length - 1; index += 1) {
      const ours = graphs[index];
      const theirs = graphs[index + 1];
      const oursThenTheirs = mergeEntityGraphRevisions(ours, theirs);
      const theirsThenOurs = mergeEntityGraphRevisions(theirs, ours);
      const expected = consolidateEntityGraph(
        emptyGraph(),
        buildCanonicalEntityGraphMergeDelta([ours, theirs]),
      ).canonicalGraph;

      expect(graphBytes(oursThenTheirs)).toBe(graphBytes(theirsThenOurs));
      expect(graphBytes(oursThenTheirs)).toBe(graphBytes(expected));
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

  it('exposes the bundled CLI merge-driver subcommand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-entity-graph-cli-'));
    roots.push(root);
    const basePath = join(root, 'base.json');
    const oursPath = join(root, 'ours.json');
    const theirsPath = join(root, 'theirs.json');
    const ours = generatedGraph(101);
    const theirs = generatedGraph(102);

    writeFileSync(basePath, renderEntityGraph(prefixCollapseRiskGraph()), 'utf-8');
    writeFileSync(oursPath, renderEntityGraph(ours), 'utf-8');
    writeFileSync(theirsPath, renderEntityGraph(theirs), 'utf-8');

    const result = await runCli(buildProgram(), ['kb', 'merge-entity-graph', basePath, oursPath, theirsPath]);

    expect(result).toEqual({ stdout: '', stderr: '', status: 0 });
    expect(readFileSync(oursPath, 'utf-8')).toBe(renderEntityGraph(mergeEntityGraphRevisions(ours, theirs)));
  });

  it('registers the git merge driver, pins the merge rebase backend, and manages KB .gitattributes', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-entity-graph-config-'));
    const pluginRoot = join(root, 'plugin root');
    roots.push(root);
    const runtime = createRealRuntime('prod');
    const gitCalls: string[][] = [];
    const execSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('git');
      gitCalls.push(args);
      return {
        stdout: args[0] === 'rev-parse' ? 'true\n' : '',
        stderr: '',
        status: 0,
      };
    });

    const controller = createGitSyncController({
      kb: {
        markdownRoot: root,
        time: runtime.time,
      } as unknown as KbRuntime,
      curateAssistant: { complete: async () => '' },
      processPort: {
        execSync,
        exec: vi.fn(),
      },
      storagePort: runtime.storage,
      envPort: {
        get: (key: string) => (key === 'CLAUDE_PLUGIN_ROOT' ? pluginRoot : undefined),
      },
    });

    controller.ensureKbMergeDrivers();

    expect(readFileSync(join(root, '.gitattributes'), 'utf-8')).toContain(
      '.entity-graph.json merge=coral-entity-graph',
    );
    expect(gitCalls).toContainEqual(['config', 'rebase.backend', 'merge']);
    const driverCall = gitCalls.find((args) => args[0] === 'config' && args[1] === 'merge.coral-entity-graph.driver');
    expect(driverCall?.[2]).toContain('kb merge-entity-graph "%O" "%A" "%B"');
    expect(driverCall?.[2]).toContain(join('bridge', 'coral-cli.cjs'));
  });

  it('normalizes the entity graph after inbound sync only when the graph changed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-entity-graph-inbound-'));
    roots.push(root);
    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db,
    });
    const nonFixpointGraph = prefixCollapseRiskGraph();
    const graphPath = kb.entityGraphPath();
    writeFileSync(graphPath, renderEntityGraph(nonFixpointGraph), 'utf-8');
    kb.writeIndex({
      entries: {},
      principles: {},
      entityMeta: nonFixpointGraph.entityMeta,
      relationships: nonFixpointGraph.relationships,
    });

    const nonCanonicalRaw = renderEntityGraph(nonFixpointGraph);

    await kb.runInboundSync(() => ({ kind: 'no-change' as const }), { structuredDiff: true });
    expect(readFileSync(graphPath, 'utf-8')).toBe(nonCanonicalRaw);

    await kb.runInboundSync(
      () => ({
        kind: 'paths' as const,
        changes: [{ status: 'modified' as const, path: '.entity-graph.json' }],
      }),
      { structuredDiff: true },
    );

    const canonicalRaw = renderEntityGraph(consolidateCanonicalEntityGraph(nonFixpointGraph));
    expect(readFileSync(graphPath, 'utf-8')).toBe(canonicalRaw);
    expect(kb.readIndex()?.entityMeta).toEqual(JSON.parse(canonicalRaw).entityMeta);

    await kb.runInboundSync(() => ({ kind: 'no-change' as const }), { structuredDiff: true });
    expect(readFileSync(graphPath, 'utf-8')).toBe(canonicalRaw);
  });
});
