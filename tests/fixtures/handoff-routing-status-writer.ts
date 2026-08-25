import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import {
  publishGenerationCoordinatedHandoffRoutingTransitions,
  readHandoffRoutingStatus,
  type HandoffRoutingTransition,
  type PublicationOutcome,
} from '#src/coordinator/handoff-routing-status.js';
import { discardHandoffRoutingStatus } from '#src/coordinator/handoff-routing-status-operator.js';
import { acquireOperatorSocketGuard } from '#src/cli/operator-socket-guard.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { HANDOFF_ROUTING_STATUS_GENERATION } from '#src/store/handoff-routing-status-store.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const [, , mode, path, identity = 'worker', baseDir] = process.argv;
if (mode === undefined || path === undefined) throw new Error('Expected mode and database path');

const runtime = createRealRuntime('prod', baseDir === undefined ? undefined : { baseDir });
const owner = { pid: process.pid, incarnation: testIncarnation(process.pid) } as const;
const observedAt = (offset: number): string => new Date(Date.parse('2026-02-01T00:00:00.000Z') + offset).toISOString();

function emit(value: unknown): void {
  writeSync(1, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function stopAt(marker: string): void {
  emit(marker);
  process.kill(process.pid, 'SIGSTOP');
}

function selection(eventIdentity: string, offset: number): HandoffRoutingTransition {
  return {
    kind: 'routing-selected',
    eventId: `selection-${eventIdentity}`,
    invocationId: `invocation-${eventIdentity}`,
    observedAt: observedAt(offset),
    owner,
    disposition: {
      kind: 'continue-current',
      basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
    },
  };
}

function terminal(eventIdentity: string, offset: number, selectionSequence: number): HandoffRoutingTransition {
  return {
    kind: 'continuation-finalized',
    eventId: `terminal-${eventIdentity}`,
    invocationId: `invocation-${eventIdentity}`,
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

function insertGapRecord(db: DatabaseSync, sequence: number): void {
  const eventId = `crash-gap-event-${sequence}`;
  const invocationId = `crash-gap-invocation-${sequence}`;
  const event = {
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequence,
    eventId,
    invocationId,
    observedAt: observedAt(sequence),
    eventKind: 'execution-failed',
    phase: 'terminal',
    selection: { kind: 'without-selection' },
    disposition: { kind: 'failed-without-selection', throwPhase: 'child-spawn' },
  };
  db.prepare(
    `INSERT INTO handoff_routing_records (
      sequence,
      generation,
      event_id,
      invocation_id,
      observed_at,
      record_kind,
      event_kind,
      selection_sequence,
      retirement_cause,
      terminal_existed,
      body_json
    ) VALUES (?, ?, ?, ?, ?, 'terminal', 'execution-failed', NULL, NULL, NULL, ?)`,
  ).run(sequence, HANDOFF_ROUTING_STATUS_GENERATION, eventId, invocationId, event.observedAt, JSON.stringify(event));
}

function runValidateStop(): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('BEGIN IMMEDIATE');
    insertGapRecord(db, 2);
    stopAt('inside-transaction');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  emit('committed');
}

function runBetweenStatements(): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('BEGIN IMMEDIATE');
    insertGapRecord(db, 2);
    stopAt('between-statements');
    insertGapRecord(db, 3);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  emit('committed');
}

async function runAfterCommit(): Promise<void> {
  const outcome = await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [selection(identity, 1)]);
  if (outcome.kind !== 'committed') throw new Error(`Expected committed outcome, received ${outcome.kind}`);
  stopAt('after-commit');
}

function runHoldingTransaction(): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('BEGIN IMMEDIATE');
    stopAt('holding-transaction');
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
  emit('released');
}

async function runContendedSelection(): Promise<void> {
  if (process.platform === 'win32') emit('ready');
  else stopAt('ready');
  const keepAlive = setInterval(() => undefined, 1_000);
  let reportedContention = false;
  try {
    const contentionTime = {
      ...runtime.time,
      sleep: async (ms: number, options?: { signal?: AbortSignal }): Promise<void> => {
        if (!reportedContention) {
          reportedContention = true;
          emit('contended');
        }
        await runtime.time.sleep(ms, options);
      },
    };
    const started = performance.now();
    const outcome = await publishGenerationCoordinatedHandoffRoutingTransitions(
      { ...runtime, time: contentionTime },
      path,
      [selection(identity, 1)],
    );
    emit({ kind: 'contention-result', outcome, elapsedMs: performance.now() - started });
  } finally {
    clearInterval(keepAlive);
  }
}

async function runLifecycle(): Promise<void> {
  if (process.platform === 'win32') emit('ready');
  else stopAt('ready');
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    const lifecycleStarted = performance.now();
    const selectionStarted = performance.now();
    const selected = await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [
      selection(identity, 1),
    ]);
    const selectionMs = performance.now() - selectionStarted;
    let terminalOutcome: PublicationOutcome | undefined;
    let terminalMs: number | undefined;
    if (selected.kind === 'committed') {
      const terminalStarted = performance.now();
      terminalOutcome = await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [
        terminal(identity, 2, selected.sequence),
      ]);
      terminalMs = performance.now() - terminalStarted;
    }
    emit({
      kind: 'benchmark-result',
      selection: selected,
      terminal: terminalOutcome,
      selectionMs,
      terminalMs,
      lifecycleMs: performance.now() - lifecycleStarted,
    });
  } finally {
    clearInterval(keepAlive);
  }
}

async function runStaleDiscard(): Promise<void> {
  const observed = readHandoffRoutingStatus(runtime, path);
  if (observed.kind !== 'unreadable' && observed.kind !== 'unsupported-generation') {
    throw new Error(`Expected a discardable observation, received ${observed.kind}`);
  }
  stopAt('discardable-observed');
  emit(await discardHandoffRoutingStatus({ runtime, path, acquireSocketGuard: acquireOperatorSocketGuard }));
}

async function runCoordinatedPublication(): Promise<void> {
  emit(await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [selection(identity, 1)]));
}

async function run(): Promise<void> {
  switch (mode) {
    case 'validate-stop':
      runValidateStop();
      return;
    case 'between-statements':
      runBetweenStatements();
      return;
    case 'after-commit':
      await runAfterCommit();
      return;
    case 'hold-transaction':
      runHoldingTransaction();
      return;
    case 'contended-selection':
      await runContendedSelection();
      return;
    case 'lifecycle':
      await runLifecycle();
      return;
    case 'stale-discard':
      await runStaleDiscard();
      return;
    case 'coordinated-publication':
      await runCoordinatedPublication();
      return;
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

await run();
