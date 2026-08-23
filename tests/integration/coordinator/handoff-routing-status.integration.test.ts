import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_COMPLETED_HANDOFF_ROUTING_PAIRS,
  MAX_RETIREMENT_TOMBSTONES,
  MAX_UNRESOLVED_INVOCATIONS,
  publishHandoffRoutingTransitions,
  type HandoffRoutingTransition,
  type PublicationOutcome,
} from '#src/coordinator/handoff-routing-status.js';
import { createRealTimePort } from '#src/infra/time.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const FORMER_DIRECTORY_LOCK_STALE_MS = 30_000;
const PUBLICATION_P95_GATE_MS = 50;
// This arm releases writers together against a maximum-retained store, so their FULL-fsync commits queue and
// it is slower than the sequential arm by construction — a shared gate would be measuring the storage, not a
// regression. Set so a doubling of the observed p95 fails it.
const CONCURRENT_PUBLICATION_P95_GATE_MS = 125;
const LIFECYCLE_MAX_GATE_MS = 250;
const PUBLICATION_CONTENTION_TIMEOUT_MS = 1_000;
const BENCHMARK_LIFECYCLES = 100;
const CONCURRENT_WRITERS = 2;
const time = createRealTimePort();
const temporaryDirectories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
let workerBundlePath: string;

type Writer = Readonly<{
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterator<string>;
  stderr: () => string;
}>;

type BenchmarkResult = Readonly<{
  kind: 'benchmark-result';
  selection: PublicationOutcome;
  terminal?: PublicationOutcome;
  selectionMs: number;
  terminalMs?: number;
  lifecycleMs: number;
}>;

type ContentionResult = Readonly<{
  kind: 'contention-result';
  outcome: PublicationOutcome;
  elapsedMs: number;
}>;

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-integration-'));
  temporaryDirectories.push(directory);
  return join(directory, 'handoff-routing.1.db');
}

function owner(pid = process.pid): Readonly<{ pid: number; incarnation: ReturnType<typeof testIncarnation> }> {
  return { pid, incarnation: testIncarnation(pid) };
}

function observedAt(offset: number): string {
  return new Date(Date.parse('2026-03-01T00:00:00.000Z') + offset).toISOString();
}

function selection(identity: string, offset: number): HandoffRoutingTransition {
  return {
    kind: 'routing-selected',
    eventId: `selection-${identity}`,
    invocationId: `invocation-${identity}`,
    observedAt: observedAt(offset),
    owner: owner(),
    disposition: {
      kind: 'continue-current',
      basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
    },
  };
}

function terminal(identity: string, offset: number, selectionSequence: number): HandoffRoutingTransition {
  return {
    kind: 'continuation-finalized',
    eventId: `terminal-${identity}`,
    invocationId: `invocation-${identity}`,
    observedAt: observedAt(offset),
    selection: { kind: 'with-selection-sequence', selectionSequence },
    disposition: {
      kind: 'continued-current',
      reason: {
        kind: 'routing',
        basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
      },
    },
  };
}

async function committed(path: string, transition: HandoffRoutingTransition): Promise<number> {
  const outcome = await publishHandoffRoutingTransitions(time, path, [transition]);
  expect(outcome.kind).toBe('committed');
  if (outcome.kind !== 'committed') throw new Error(`Expected commit, received ${outcome.kind}`);
  return outcome.sequence;
}

function storeSnapshot(path: string): Readonly<{ integrity: string; invocations: readonly string[] }> {
  const db = new DatabaseSync(path);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as Readonly<{ integrity_check: string }>;
    const invocations = db
      .prepare('SELECT invocation_id FROM handoff_routing_records ORDER BY sequence')
      .all() as Array<Readonly<{ invocation_id: string }>>;
    return { integrity: integrity.integrity_check, invocations: invocations.map((row) => row.invocation_id) };
  } finally {
    db.close();
  }
}

function spawnWriter(mode: string, path: string, identity?: string): Writer {
  const child = spawn(process.execPath, [workerBundlePath, mode, path, identity ?? 'worker'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lineReader = createInterface({ input: child.stdout });
  return { child, lines: lineReader[Symbol.asyncIterator](), stderr: () => stderr };
}

async function nextLine(writer: Writer): Promise<string> {
  const result = await Promise.race([
    writer.lines.next(),
    time.sleep(10_000).then(() => {
      throw new Error(`Timed out waiting for writer ${writer.child.pid}: ${writer.stderr()}`);
    }),
  ]);
  if (result.done) throw new Error(`Writer exited before producing output: ${writer.stderr()}`);
  return result.value;
}

async function waitForStopped(pid: number): Promise<void> {
  const deadline = time.now() + 5_000;
  while (time.now() < deadline) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      if (/^State:\s+T/m.test(status)) return;
    } catch {
      // The assertion below reports a child that exited before reaching its cut.
    }
    await time.sleep(5);
  }
  throw new Error(`Writer ${pid} did not enter the stopped state`);
}

async function killWriter(writer: Pick<Writer, 'child'>): Promise<void> {
  if (writer.child.exitCode !== null || writer.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => writer.child.once('exit', () => resolve()));
  writer.child.kill('SIGKILL');
  await exited;
}

function resumeWriter(writer: Pick<Writer, 'child'>): void {
  if (process.platform === 'win32') writer.child.stdin.end();
  else writer.child.kill('SIGCONT');
}

function sqliteErrcode(run: () => void): number | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'errcode' in error && typeof error.errcode === 'number'
      ? error.errcode
      : undefined;
  }
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function populateMaximumRetainedStore(path: string): Promise<void> {
  for (let index = 0; index < MAX_COMPLETED_HANDOFF_ROUTING_PAIRS; index += 1) {
    const identity = `retained-pair-${index}`;
    const selected = await committed(path, selection(identity, index * 2));
    await committed(path, terminal(identity, index * 2 + 1, selected));
  }
  const openings = Array.from({ length: MAX_UNRESOLVED_INVOCATIONS + MAX_RETIREMENT_TOMBSTONES }, (_, index) =>
    selection(`retained-opening-${index}`, 1_000 + index),
  );
  const outcome = await publishHandoffRoutingTransitions(time, path, openings);
  expect(outcome.kind).toBe('committed');
}

async function benchmarkSequential(
  path: string,
): Promise<Readonly<{ publicationP95Ms: number; lifecycleMaxMs: number }>> {
  const publications: number[] = [];
  const lifecycles: number[] = [];
  for (let index = 0; index < BENCHMARK_LIFECYCLES; index += 1) {
    const identity = `sequential-${index}`;
    const lifecycleStarted = performance.now();
    const selectionStarted = performance.now();
    const selected = await committed(path, selection(identity, 2_000 + index * 2));
    publications.push(performance.now() - selectionStarted);
    const terminalStarted = performance.now();
    await committed(path, terminal(identity, 2_001 + index * 2, selected));
    publications.push(performance.now() - terminalStarted);
    lifecycles.push(performance.now() - lifecycleStarted);
  }
  return { publicationP95Ms: percentile95(publications), lifecycleMaxMs: Math.max(...lifecycles) };
}

async function benchmarkConcurrent(path: string): Promise<
  Readonly<{
    publicationP95Ms: number;
    lifecycleMaxMs: number;
    refusalCount: number;
    retryCommitMs: number;
    refusalMs: number;
  }>
> {
  const retryHolder = spawnWriter('hold-transaction', path);
  expect(await nextLine(retryHolder)).toBe('holding-transaction');
  const retryingWriter = spawnWriter('contended-selection', path, 'retrying-contender');
  expect(await nextLine(retryingWriter)).toBe('ready');
  resumeWriter(retryingWriter);
  expect(await nextLine(retryingWriter)).toBe('contended');
  resumeWriter(retryHolder);
  expect(await nextLine(retryHolder)).toBe('released');
  const retried = JSON.parse(await nextLine(retryingWriter)) as ContentionResult;
  expect(retried.outcome.kind).toBe('committed');
  expect(retried.elapsedMs).toBeLessThanOrEqual(PUBLICATION_CONTENTION_TIMEOUT_MS);

  const refusalHolder = spawnWriter('hold-transaction', path);
  expect(await nextLine(refusalHolder)).toBe('holding-transaction');
  const refusingWriter = spawnWriter('contended-selection', path, 'refusing-contender');
  expect(await nextLine(refusingWriter)).toBe('ready');
  resumeWriter(refusingWriter);
  expect(await nextLine(refusingWriter)).toBe('contended');
  const refused = JSON.parse(await nextLine(refusingWriter)) as ContentionResult;
  expect(refused.outcome).toEqual({ kind: 'not-published', cause: 'contended' });
  expect(refused.elapsedMs).toBeGreaterThanOrEqual(PUBLICATION_CONTENTION_TIMEOUT_MS);
  expect(refused.elapsedMs).toBeLessThan(PUBLICATION_CONTENTION_TIMEOUT_MS + 500);
  resumeWriter(refusalHolder);
  expect(await nextLine(refusalHolder)).toBe('released');

  const results: BenchmarkResult[] = [];
  for (let batch = 0; batch < BENCHMARK_LIFECYCLES / CONCURRENT_WRITERS; batch += 1) {
    const writers = Array.from({ length: CONCURRENT_WRITERS }, (_, slot) =>
      spawnWriter('lifecycle', path, `concurrent-${batch}-${slot}`),
    );
    await Promise.all(
      writers.map(async (writer) => {
        expect(await nextLine(writer)).toBe('ready');
      }),
    );
    for (const writer of writers) {
      resumeWriter(writer);
    }
    const batchResults = await Promise.all(
      writers.map(async (writer) => JSON.parse(await nextLine(writer)) as BenchmarkResult),
    );
    results.push(...batchResults);
  }
  const publications: number[] = [];
  const lifecycles: number[] = [];
  let refusalCount = 1;
  for (const result of results) {
    if (result.selection.kind === 'committed') publications.push(result.selectionMs);
    else refusalCount += 1;

    if (result.terminal?.kind === 'committed') {
      expect(result.terminalMs).toBeTypeOf('number');
      if (result.terminalMs === undefined) throw new Error('Committed terminal publication has no timing');
      publications.push(result.terminalMs);
      lifecycles.push(result.lifecycleMs);
    } else if (result.terminal !== undefined) {
      refusalCount += 1;
    }
  }
  return {
    publicationP95Ms: percentile95(publications),
    lifecycleMaxMs: Math.max(...lifecycles),
    refusalCount,
    retryCommitMs: retried.elapsedMs,
    refusalMs: refused.elapsedMs,
  };
}

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-worker-'));
  temporaryDirectories.push(directory);
  workerBundlePath = join(directory, 'writer.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../../fixtures/handoff-routing-status-writer.ts', import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
  });
});

afterEach(async () => {
  await Promise.all([...children].map(async (child) => killWriter({ child })));
});

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('handoff routing status transaction durability', () => {
  it.skipIf(process.platform !== 'linux')(
    'retains exclusion past the former stale threshold, releases on death, and recovers an in-transaction cut',
    async () => {
      const path = databasePath();
      await committed(path, selection('previous', 0));
      const previous = storeSnapshot(path);
      const writer = spawnWriter('validate-stop', path, 'next');
      expect(await nextLine(writer)).toBe('inside-transaction');
      const pid = writer.child.pid;
      if (pid === undefined) throw new Error('Writer has no pid');
      await waitForStopped(pid);

      const immediateContender = new DatabaseSync(path);
      immediateContender.exec('PRAGMA busy_timeout=0');
      expect(sqliteErrcode(() => immediateContender.exec('BEGIN IMMEDIATE'))).toBe(5);
      immediateContender.close();

      await time.sleep(FORMER_DIRECTORY_LOCK_STALE_MS + 50);
      const contender = new DatabaseSync(path);
      contender.exec('PRAGMA busy_timeout=0');
      expect(sqliteErrcode(() => contender.exec('BEGIN IMMEDIATE'))).toBe(5);

      await killWriter(writer);
      const acquisitionStarted = performance.now();
      contender.exec('BEGIN IMMEDIATE');
      const acquisitionMs = performance.now() - acquisitionStarted;
      contender.exec('ROLLBACK');
      contender.close();
      expect(acquisitionMs).toBeLessThan(PUBLICATION_P95_GATE_MS);

      expect(storeSnapshot(path)).toEqual(previous);
      expect(storeSnapshot(path).integrity).toBe('ok');
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'recovers the whole previous state when killed between statements',
    async () => {
      const path = databasePath();
      await committed(path, selection('previous', 0));
      const previous = storeSnapshot(path);
      const writer = spawnWriter('between-statements', path);
      expect(await nextLine(writer)).toBe('between-statements');
      const pid = writer.child.pid;
      if (pid === undefined) throw new Error('Writer has no pid');
      await waitForStopped(pid);
      await killWriter(writer);

      const recovered = storeSnapshot(path);
      expect(recovered).toEqual(previous);
      expect(recovered.integrity).toBe('ok');
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'recovers the whole next state when killed immediately after commit',
    async () => {
      const path = databasePath();
      await committed(path, selection('previous', 0));
      const writer = spawnWriter('after-commit', path, 'next');
      expect(await nextLine(writer)).toBe('after-commit');
      const pid = writer.child.pid;
      if (pid === undefined) throw new Error('Writer has no pid');
      await waitForStopped(pid);
      await killWriter(writer);

      expect(storeSnapshot(path)).toEqual({
        integrity: 'ok',
        invocations: ['invocation-previous', 'invocation-next'],
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'meets the maximum-retained-store publication gates sequentially and with concurrent writers',
    async () => {
      const path = databasePath();
      await populateMaximumRetainedStore(path);
      const sequential = await benchmarkSequential(path);
      const concurrent = await benchmarkConcurrent(path);
      const measurements = { platform: process.platform, sequential, concurrent };
      console.info(`HANDOFF_ROUTING_BENCHMARK ${JSON.stringify(measurements)}`);

      if (process.platform === 'linux') {
        expect(sequential.publicationP95Ms).toBeLessThanOrEqual(PUBLICATION_P95_GATE_MS);
        expect(sequential.lifecycleMaxMs).toBeLessThanOrEqual(LIFECYCLE_MAX_GATE_MS);
        expect(concurrent.refusalCount).toBeGreaterThan(0);
        expect(concurrent.publicationP95Ms).toBeLessThanOrEqual(CONCURRENT_PUBLICATION_P95_GATE_MS);
        expect(concurrent.lifecycleMaxMs).toBeLessThanOrEqual(LIFECYCLE_MAX_GATE_MS);
      }
    },
    300_000,
  );
});
