#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const DIST_ROOT = resolve(ROOT, 'dist');
const BUILD_ROOT = resolve(ROOT, 'build');
const SIMULATION_BUNDLE = resolve(BUILD_ROOT, 'simulation-core.mjs');
const DISCUSS_HELPERS_BUNDLE = resolve(BUILD_ROOT, 'discuss-golden-helpers.mjs');
const FIXTURE_DIR = resolve(ROOT, 'tests/unit/discuss/fixtures');
const FIXTURE_JSON = resolve(FIXTURE_DIR, 'session-store-golden.json');
const FIXTURE_EVENTS = resolve(FIXTURE_DIR, 'session-store-golden.events.jsonl');
const FIXTURE_TS = Date.parse('2035-04-15T01:02:03.000Z');
const FIXTURE_TMP_ROOT = '/fixture/discuss-golden';
const FIXTURE_PROJECT_ROOT = '/fixture/discuss-golden/project';
const FIXTURE_PLUGIN_ROOT = '/fixture/discuss-golden/plugin';
const FIXTURE_SESSION_ID = 'discuss-golden';

function assertBuilt(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing built module: ${path}. Run npm run build first.`);
  }
}

function uuidFor(index) {
  return `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
}

function buildNormalizer(rootValues) {
  const uuidMap = new Map();

  function normalizeString(value) {
    const isoTsPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
    const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

    let next = value;
    for (const rootValue of rootValues) {
      if (rootValue.length === 0) {
        continue;
      }
      next = next.split(rootValue).join('<root>');
    }
    if (isoTsPattern.test(next)) {
      return '<ts>';
    }

    return next.replace(uuidPattern, (matched) => {
      const lowered = matched.toLowerCase();
      if (!uuidMap.has(lowered)) {
        uuidMap.set(lowered, uuidFor(uuidMap.size + 1));
      }
      return uuidMap.get(lowered);
    });
  }

  function normalize(value, key = '') {
    if (typeof value === 'string') {
      return normalizeString(value);
    }
    if (typeof value === 'number' && key === 'pid') {
      return 4242;
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, normalize(entryValue, entryKey)]),
    );
  }

  return normalize;
}

async function main() {
  assertBuilt(resolve(DIST_ROOT, 'discuss/shell/operations.js'));
  assertBuilt(resolve(DIST_ROOT, 'discuss/shell/persistence.js'));
  mkdirSync(BUILD_ROOT, { recursive: true });
  const debugBundleOptions = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    external: ['node:*', 'better-sqlite3'],
  };
  await Promise.all([
    esbuild.build({
      ...debugBundleOptions,
      entryPoints: [resolve(ROOT, 'tests/unit/discuss/shell/discuss-test-helpers.ts')],
      outfile: DISCUSS_HELPERS_BUNDLE,
      external: [...debugBundleOptions.external, 'vitest'],
    }),
    esbuild.build({
      ...debugBundleOptions,
      entryPoints: [resolve(ROOT, 'tools/simulation/core/backend.ts')],
      outfile: SIMULATION_BUNDLE,
    }),
  ]);

  const [helpers, operations, persistence, simulation] = await Promise.all([
    import(pathToFileURL(DISCUSS_HELPERS_BUNDLE).href),
    import(pathToFileURL(resolve(DIST_ROOT, 'discuss/shell/operations.js')).href),
    import(pathToFileURL(resolve(DIST_ROOT, 'discuss/shell/persistence.js')).href),
    import(pathToFileURL(SIMULATION_BUNDLE).href),
  ]);

  const { createDiscussHarness, advanceDiscussRuntime, cleanupDiscussHarnesses } = helpers;
  const { startDiscussSession } = operations;
  const { readSessionEvents } = persistence;
  const { SimulationRuntime } = simulation;

  const runtime = new SimulationRuntime({ epochMs: FIXTURE_TS });
  const pendingResults = new Map();
  const launchPlan = [
    { mode: 'start', content: '{"score": 82, "thought": "Open with the transit-heavy downtown blocks."}' },
    { mode: 'resume', content: 'Start with bus lanes, curb access windows, and delivery exemptions.' },
    { mode: 'resume', content: '{"score": 12, "thought": "The threshold is no longer met."}' },
    {
      mode: 'resume',
      content:
        'Pedestrianize the transit core first, protect freight windows, and validate the rollout with a staged pilot.',
    },
  ];

  const service = {
    async start() {
      const next = launchPlan.shift();
      if (!next || next.mode !== 'start') {
        throw new Error(`Unexpected start turn order: ${JSON.stringify(next)}`);
      }
      const session = runtime.ids.uuid();
      const job = runtime.ids.uuid();
      pendingResults.set(job, { content: next.content, nonResumable: false });
      return { status: 'running', session, job };
    },
    async resume(_provider, options) {
      const next = launchPlan.shift();
      if (!next || next.mode !== 'resume') {
        throw new Error(`Unexpected resume turn order: ${JSON.stringify(next)}`);
      }
      const job = runtime.ids.uuid();
      pendingResults.set(job, { content: next.content, nonResumable: false });
      return { status: 'running', session: options.sessionId, job };
    },
    async waitStreamOnce(jobId) {
      const result = pendingResults.get(jobId);
      if (!result) {
        throw new Error(`No pending discuss result for job ${jobId}`);
      }
      pendingResults.delete(jobId);
      return result;
    },
  };

  const harness = createDiscussHarness(service, {
    runtime,
    tmpRoot: FIXTURE_TMP_ROOT,
    projectRoot: FIXTURE_PROJECT_ROOT,
    pluginRoot: FIXTURE_PLUGIN_ROOT,
  });

  try {
    await startDiscussSession(
      harness.context,
      FIXTURE_SESSION_ID,
      'Should the city pedestrianize the downtown core?',
      [
        { name: 'alpha', persona: '# Alpha', provider: 'codex', model: 'gpt-5' },
        { name: 'observer', persona: '# Observer', participation: 'observer' },
      ],
      {},
      harness.ctx,
    );
    for (let index = 0; index < 8; index += 1) {
      await advanceDiscussRuntime(harness, 10);
      const currentEvents = readSessionEvents(harness.context, FIXTURE_SESSION_ID);
      if (currentEvents.at(-1)?.kind === 'session.synthesized') {
        break;
      }
    }

    const snapshot = harness.store.load(FIXTURE_SESSION_ID);
    if (!snapshot) {
      throw new Error('Golden capture produced no persisted snapshot');
    }
    const events = readSessionEvents(harness.context, FIXTURE_SESSION_ID);
    if (events.length === 0) {
      throw new Error('Golden capture produced no discuss events');
    }
    if (events.at(-1)?.kind !== 'session.synthesized') {
      throw new Error(`Golden capture did not reach synthesis terminal event; last=${events.at(-1)?.kind ?? 'none'}`);
    }

    const { logByteOffset: _ignoredLogByteOffset, ...snapshotForFixture } = snapshot;
    const normalize = buildNormalizer([FIXTURE_PROJECT_ROOT, FIXTURE_PLUGIN_ROOT, FIXTURE_TMP_ROOT]);
    const normalizedSnapshot = normalize(snapshotForFixture);
    const normalizedEvents = events.map((event) => normalize(event));

    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_JSON, JSON.stringify(normalizedSnapshot), 'utf8');
    writeFileSync(FIXTURE_EVENTS, `${normalizedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  } finally {
    harness.cleanup();
    cleanupDiscussHarnesses();
  }
}

await main();
