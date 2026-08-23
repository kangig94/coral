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
  MAX_HANDOFF_ROUTING_STATUS_BYTES,
  MAX_LEGAL_CONTINUATION_FINALIZED_TRANSITION,
  MAX_LEGAL_ROUTING_SELECTED_TRANSITION,
  MAX_RETIREMENT_TOMBSTONES,
  MAX_UNRESOLVED_INVOCATIONS,
  publishHandoffRoutingTransitions,
  type HandoffRoutingTransition,
  type PublicationOutcome,
} from '#src/coordinator/handoff-routing-status.js';
import { createRealTimePort } from '#src/infra/time.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const FORMER_DIRECTORY_LOCK_STALE_MS = 30_000;
const LOCK_RELEASE_GATE_MS = 50;
const BENCHMARK_LIFECYCLES = 100;
const CONCURRENT_WRITERS = 2;
const BYTE_PRESSURE_COMPLETED_PAIRS = 204;
const BYTE_PRESSURE_BATCHED_PAIRS = 180;
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

function maximumIdentifier(identity: string): string {
  const encodedIdentity = [...identity]
    .map((character) => String.fromCharCode(0x0800 + character.charCodeAt(0)))
    .join('');
  return `${encodedIdentity}${'\u0800'.repeat(58)}`.slice(0, 58);
}

function maximumSelection(identity: string): HandoffRoutingTransition {
  return {
    ...MAX_LEGAL_ROUTING_SELECTED_TRANSITION,
    eventId: maximumIdentifier(`s${identity}`),
    invocationId: maximumIdentifier(`i${identity}`),
  };
}

function maximumTerminal(identity: string, selectionSequence: number): HandoffRoutingTransition {
  return {
    ...MAX_LEGAL_CONTINUATION_FINALIZED_TRANSITION,
    eventId: maximumIdentifier(`t${identity}`),
    invocationId: maximumIdentifier(`i${identity}`),
    selection: { kind: 'with-selection-sequence', selectionSequence },
  };
}

function maximumGapTerminal(identity: string): HandoffRoutingTransition {
  return {
    ...MAX_LEGAL_CONTINUATION_FINALIZED_TRANSITION,
    eventId: maximumIdentifier(`g${identity}`),
    invocationId: maximumIdentifier(`x${identity}`),
    selection: { kind: 'without-selection' },
  };
}

function maximumResolution(identity: string, selectionSequence: number): HandoffRoutingTransition {
  return {
    kind: 'operator-resolved',
    eventId: maximumIdentifier(`r${identity}`),
    invocationId: maximumIdentifier(`i${identity}`),
    observedAt: MAX_LEGAL_ROUTING_SELECTED_TRANSITION.observedAt,
    selectionSequence,
    reason: 'operator-abandoned-unobservable',
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

function retainedRecordCounts(path: string): Readonly<{
  completedPairs: number;
  unresolved: number;
  tombstones: number;
}> {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(
        `SELECT
          COUNT(*) FILTER (WHERE record_kind = 'terminal') AS completedPairs,
          COUNT(*) FILTER (WHERE record_kind = 'selection' AND NOT EXISTS (
            SELECT 1 FROM handoff_routing_records AS terminal
            WHERE terminal.invocation_id = handoff_routing_records.invocation_id
              AND terminal.record_kind = 'terminal'
          )) AS unresolved,
          COUNT(*) FILTER (WHERE record_kind = 'retirement') AS tombstones
        FROM handoff_routing_records`,
      )
      .get() as Readonly<{ completedPairs: number; unresolved: number; tombstones: number }>;
  } finally {
    db.close();
  }
}

function databaseCapacity(path: string): Readonly<{ pageCount: number; freeListCount: number; maxPageCount: number }> {
  const db = new DatabaseSync(path);
  try {
    const pageSize = (db.prepare('PRAGMA page_size').get() as Readonly<{ page_size: number }>).page_size;
    return {
      pageCount: (db.prepare('PRAGMA page_count').get() as Readonly<{ page_count: number }>).page_count,
      freeListCount: (db.prepare('PRAGMA freelist_count').get() as Readonly<{ freelist_count: number }>).freelist_count,
      maxPageCount: Math.floor(MAX_HANDOFF_ROUTING_STATUS_BYTES / pageSize),
    };
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
    } catch (error) {
      void error;
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
    const selected = await committed(path, maximumSelection(identity));
    await committed(path, maximumTerminal(identity, selected));
  }
  const openings = Array.from({ length: MAX_UNRESOLVED_INVOCATIONS + MAX_RETIREMENT_TOMBSTONES }, (_, index) =>
    maximumSelection(`retained-opening-${index}`),
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

async function benchmarkRetryContention(path: string): Promise<number> {
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
  return retried.elapsedMs;
}

async function benchmarkRefusalContention(path: string): Promise<number> {
  const refusalHolder = spawnWriter('hold-transaction', path);
  expect(await nextLine(refusalHolder)).toBe('holding-transaction');
  const refusingWriter = spawnWriter('contended-selection', path, 'refusing-contender');
  expect(await nextLine(refusingWriter)).toBe('ready');
  resumeWriter(refusingWriter);
  expect(await nextLine(refusingWriter)).toBe('contended');
  const refused = JSON.parse(await nextLine(refusingWriter)) as ContentionResult;
  expect(refused.outcome).toEqual({ kind: 'not-published', cause: 'contended' });
  resumeWriter(refusalHolder);
  expect(await nextLine(refusalHolder)).toBe('released');
  return refused.elapsedMs;
}

async function benchmarkConcurrentLifecycles(
  path: string,
): Promise<Readonly<{ publicationP95Ms: number; lifecycleP95Ms: number }>> {
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
  expect(results).toHaveLength(BENCHMARK_LIFECYCLES);
  for (const result of results) {
    expect(result.selection.kind).toBe('committed');
    expect(result.terminal?.kind).toBe('committed');
    expect(result.terminalMs).toBeTypeOf('number');
    if (result.selection.kind !== 'committed') throw new Error('Benchmark selection did not commit');
    if (result.terminal?.kind !== 'committed') throw new Error('Benchmark terminal did not commit');
    if (result.terminalMs === undefined) throw new Error('Committed terminal publication has no timing');
    publications.push(result.selectionMs, result.terminalMs);
    lifecycles.push(result.lifecycleMs);
  }
  return {
    publicationP95Ms: percentile95(publications),
    // A maximum here measures host scheduler and journal-commit extremes rather than the steady contention cost.
    lifecycleP95Ms: percentile95(lifecycles),
  };
}

async function benchmarkConcurrent(path: string): Promise<
  Readonly<{
    publicationP95Ms: number;
    lifecycleP95Ms: number;
    retryCommitMs: number;
    refusalMs: number;
  }>
> {
  const retryCommitMs = await benchmarkRetryContention(path);
  const refusalMs = await benchmarkRefusalContention(path);
  const lifecycles = await benchmarkConcurrentLifecycles(path);
  return { ...lifecycles, retryCommitMs, refusalMs };
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
  it('reserves byte capacity for selection admission and retained-opening closure', async () => {
    const path = databasePath();
    const opening = maximumSelection('opening');
    const fill = Array.from({ length: BYTE_PRESSURE_BATCHED_PAIRS }, (_, index) => {
      const selectionSequence = 2 + index * 2;
      const identity = `pair-${index}`;
      return [maximumSelection(identity), maximumTerminal(identity, selectionSequence)];
    }).flat();
    await committed(path, opening);
    const fillOutcome = await publishHandoffRoutingTransitions(time, path, fill);
    expect(fillOutcome).toEqual({ kind: 'committed', sequence: expect.any(Number) });
    for (let index = BYTE_PRESSURE_BATCHED_PAIRS; index < BYTE_PRESSURE_COMPLETED_PAIRS; index += 1) {
      const identity = `pair-${index}`;
      const selected = await committed(path, maximumSelection(identity));
      await committed(path, maximumTerminal(identity, selected));
    }

    const admitted = await publishHandoffRoutingTransitions(time, path, [maximumSelection('admitted')]);
    const closedOpening = await publishHandoffRoutingTransitions(time, path, [maximumTerminal('opening', 1)]);
    const closedAdmission =
      admitted.kind === 'committed'
        ? await publishHandoffRoutingTransitions(time, path, [maximumTerminal('admitted', admitted.sequence)])
        : undefined;

    expect({ admitted, closedOpening, closedAdmission }).toEqual({
      admitted: expect.objectContaining({ kind: 'committed' }),
      closedOpening: expect.objectContaining({ kind: 'committed' }),
      closedAdmission: expect.objectContaining({ kind: 'committed' }),
    });
  });

  it('bounds gap-terminal-only history without consuming retained-opening closure capacity', async () => {
    const path = databasePath();
    const opening = await committed(path, maximumSelection('gap-opening'));
    const gapHistory = Array.from({ length: 376 }, (_, index) => maximumGapTerminal(`only-${index}`));
    await expect(publishHandoffRoutingTransitions(time, path, gapHistory)).resolves.toEqual({
      kind: 'committed',
      sequence: expect.any(Number),
    });
    expect(retainedRecordCounts(path).completedPairs).toBeLessThanOrEqual(MAX_COMPLETED_HANDOFF_ROUTING_PAIRS);

    await expect(
      publishHandoffRoutingTransitions(time, path, [maximumTerminal('gap-opening', opening)]),
    ).resolves.toEqual({ kind: 'committed', sequence: expect.any(Number) });
    await expect(publishHandoffRoutingTransitions(time, path, [maximumSelection('after-gaps')])).resolves.toEqual({
      kind: 'committed',
      sequence: expect.any(Number),
    });
  });

  it('admits a late terminal from a retained operator tombstone under completed-history pressure', async () => {
    const path = databasePath();
    for (let index = 0; index < 68; index += 1) {
      const identity = `late-pair-${index}`;
      const pairSelection = await committed(path, maximumSelection(identity));
      await committed(path, maximumTerminal(identity, pairSelection));
    }
    const selected = await committed(path, maximumSelection('resolved-under-pressure'));
    await committed(path, maximumResolution('resolved-under-pressure', selected));
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA synchronous=OFF');
      db.exec(`PRAGMA max_page_count=${MAX_HANDOFF_ROUTING_STATUS_BYTES / 4096}`);
      db.exec('CREATE TABLE pressure_padding (value BLOB NOT NULL)');
      const insert = db.prepare('INSERT INTO pressure_padding VALUES (?)');
      while (true) insert.run(Buffer.alloc(512));
    } catch (error) {
      expect(error).toMatchObject({ errcode: 13 });
    } finally {
      db.close();
    }
    const capacity = databaseCapacity(path);
    expect(capacity).toMatchObject({ pageCount: capacity.maxPageCount, freeListCount: 0 });
    expect(storeSnapshot(path).invocations).toContain(maximumIdentifier('iresolved-under-pressure'));

    await expect(
      publishHandoffRoutingTransitions(time, path, [maximumTerminal('resolved-under-pressure', selected)]),
    ).resolves.toEqual({ kind: 'committed', sequence: expect.any(Number) });
    expect(retainedRecordCounts(path).completedPairs).toBeLessThan(69);
  });

  it('keeps tombstone-only history bounded while admitting later selections', async () => {
    const path = databasePath();
    const tombstoneHistory = Array.from({ length: MAX_RETIREMENT_TOMBSTONES + 32 }, (_, index) => {
      const identity = `tombstone-only-${index}`;
      return [maximumSelection(identity), maximumResolution(identity, index * 2 + 1)];
    }).flat();
    await expect(publishHandoffRoutingTransitions(time, path, tombstoneHistory)).resolves.toEqual({
      kind: 'committed',
      sequence: expect.any(Number),
    });

    await expect(publishHandoffRoutingTransitions(time, path, [maximumSelection('after-tombstones')])).resolves.toEqual(
      { kind: 'committed', sequence: expect.any(Number) },
    );
    expect(retainedRecordCounts(path).tombstones).toBeLessThanOrEqual(MAX_RETIREMENT_TOMBSTONES);
  });

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
      expect(acquisitionMs).toBeLessThan(LOCK_RELEASE_GATE_MS);

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
    'commits maximum-retained-store lifecycles and reports sequential and concurrent timings',
    async () => {
      const path = databasePath();
      await populateMaximumRetainedStore(path);
      const retained = retainedRecordCounts(path);
      expect(retained.unresolved).toBe(MAX_UNRESOLVED_INVOCATIONS);
      expect(retained.completedPairs).toBeLessThan(MAX_COMPLETED_HANDOFF_ROUTING_PAIRS);
      expect(retained.tombstones).toBeGreaterThan(0);
      expect(retained.tombstones).toBeLessThanOrEqual(MAX_RETIREMENT_TOMBSTONES);
      const sequential = await benchmarkSequential(path);
      const concurrent = await benchmarkConcurrent(path);
      const measurements = { platform: process.platform, sequential, concurrent };
      console.info(`HANDOFF_ROUTING_BENCHMARK ${JSON.stringify(measurements)}`);
    },
    300_000,
  );
});
