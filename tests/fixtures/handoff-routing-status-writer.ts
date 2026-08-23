import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import {
  HANDOFF_ROUTING_STATUS_GENERATION,
  publishHandoffRoutingTransitions,
  type HandoffRoutingTransition,
  type PublicationOutcome,
} from '#src/coordinator/handoff-routing-status.js';
import { createRealTimePort } from '#src/infra/time.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const [, , mode, path, identity = 'worker'] = process.argv;
if (mode === undefined || path === undefined) throw new Error('Expected mode and database path');

const time = createRealTimePort();
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

async function run(): Promise<void> {
  if (mode === 'validate-stop') {
    const transition = {
      ...selection(identity, 1),
      get eventId(): string {
        stopAt('inside-transaction');
        return `selection-${identity}`;
      },
    };
    const outcome = await publishHandoffRoutingTransitions(time, path, [transition]);
    emit({ kind: 'outcome', outcome });
    return;
  }

  if (mode === 'between-statements') {
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
    return;
  }

  if (mode === 'after-commit') {
    const outcome = await publishHandoffRoutingTransitions(time, path, [selection(identity, 1)]);
    if (outcome.kind !== 'committed') throw new Error(`Expected committed outcome, received ${outcome.kind}`);
    stopAt('after-commit');
    return;
  }

  if (mode === 'hold-transaction') {
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
    return;
  }

  if (mode === 'contended-selection') {
    if (process.platform === 'win32') emit('ready');
    else stopAt('ready');
    const keepAlive = setInterval(() => undefined, 1_000);
    let reportedContention = false;
    try {
      const contentionTime = {
        now: time.now,
        sleep: async (ms: number, options?: { signal?: AbortSignal }): Promise<void> => {
          if (!reportedContention) {
            reportedContention = true;
            emit('contended');
          }
          await time.sleep(ms, options);
        },
      };
      const started = performance.now();
      const outcome = await publishHandoffRoutingTransitions(contentionTime, path, [selection(identity, 1)]);
      emit({ kind: 'contention-result', outcome, elapsedMs: performance.now() - started });
    } finally {
      clearInterval(keepAlive);
    }
    return;
  }

  if (mode === 'lifecycle') {
    if (process.platform === 'win32') emit('ready');
    else stopAt('ready');
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      const lifecycleStarted = performance.now();
      const selectionStarted = performance.now();
      const selected = await publishHandoffRoutingTransitions(time, path, [selection(identity, 1)]);
      const selectionMs = performance.now() - selectionStarted;
      let terminalOutcome: PublicationOutcome | undefined;
      let terminalMs: number | undefined;
      if (selected.kind === 'committed') {
        const terminalStarted = performance.now();
        terminalOutcome = await publishHandoffRoutingTransitions(time, path, [
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
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

await run();
