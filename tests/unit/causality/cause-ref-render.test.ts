import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoreReadContext } from '#src/store/body-codec.js';
import { createDefaultUpcasterRegistry } from '#src/store/envelope.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import type { SessionContinuityState, SessionProviderFailureReason } from '#src/sessions/fault.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';

const renderer = createCauseRefRenderer(defaultEventDescribers);

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const NOW = new Date('2026-04-22T00:00:00.000Z');
const RAW_EVENT_READ_CTX: StoreReadContext = {
  schemas: new Map(),
  upcasters: createDefaultUpcasterRegistry(),
};
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

const CONTINUITY_CASES = [
  ['verified', 'continuity verified'],
  ['missing', 'continuity missing'],
  ['unavailable', 'continuity unavailable'],
  ['pre_checkpoint_empty', 'no resumable conversation was available'],
  ['pre_checkpoint_preserved', 'existing conversation reference was preserved'],
] as const satisfies ReadonlyArray<readonly [SessionContinuityState, string]>;

const PROVIDER_FAILURE_CASES = [
  [
    'session_unavailable',
    'session detached',
    'Codex session unavailable: session detached. Start a new Coral session or resume without --session.',
  ],
  ['request_failed', 'transport reset', 'codex turn failed: transport reset.'],
] as const satisfies ReadonlyArray<readonly [SessionProviderFailureReason, string, string]>;

function createStore(): { db: InstanceType<typeof Database>; store: CoralStore } {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
  return { db, store: new CoralStore(db, RAW_EVENT_READ_CTX) };
}

function insertEvent(
  db: InstanceType<typeof Database>,
  input: {
    seq: number;
    type: string;
    stream: { kind: 'job' | 'session' | 'workflow' | 'discuss'; id: string };
    body: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO events (
      seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body_version, body
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.seq,
    NOW.toISOString(),
    input.type,
    input.stream.kind,
    input.stream.id,
    1,
    Buffer.from(JSON.stringify(input.body), 'utf-8'),
  );
}

function renderRootEventDescription(input: {
  type: string;
  stream: { kind: 'job' | 'session' | 'workflow' | 'discuss'; id: string };
  body: unknown;
}): string {
  const { db, store } = createStore();
  try {
    insertEvent(db, { seq: 1, ...input });
    return renderer.describe(
      {
        stream: input.stream,
        seq: 1,
      },
      store,
    );
  } finally {
    db.close();
  }
}

describe('cause-ref session rendering', () => {
  it.each(CONTINUITY_CASES)('renders the %s continuity fragment', (continuity, fragment) => {
    expect(
      renderRootEventDescription({
        type: 'session.interrupted',
        stream: { kind: 'session', id: `session-${continuity}` },
        body: {
          trigger: 'restart',
          continuity,
        },
      }),
    ).toBe(`App-server restarted during the turn; ${fragment}.`);
  });

  it.each(PROVIDER_FAILURE_CASES)('renders the %s provider failure message', (reason, message, expected) => {
    expect(
      renderRootEventDescription({
        type: 'session.provider_failed',
        stream: { kind: 'session', id: `session-${reason}` },
        body: {
          provider: 'codex',
          reason,
          message,
        },
      }),
    ).toBe(expected);
  });

  it('falls back to continuity unavailable for unknown runtime continuity values', () => {
    expect(
      renderRootEventDescription({
        type: 'session.interrupted',
        stream: { kind: 'session', id: 'session-unknown-continuity' },
        body: {
          trigger: 'restart',
          continuity: 'mystery_state' as SessionContinuityState,
        },
      }),
    ).toBe('App-server restarted during the turn; continuity unavailable.');
  });
});

describe('cause-ref discuss rendering', () => {
  it('renders discuss-owned agent job outcomes from the default describer composition', () => {
    expect(
      renderRootEventDescription({
        type: 'discuss.agent.job.finished',
        stream: { kind: 'discuss', id: 'discuss-1' },
        body: {
          agent: 'alpha',
          jobId: 'job-1',
          outcome: 'retryable_parse_error',
          attempt: 2,
          sourceSeq: 7,
        },
      }),
    ).toBe('Discuss agent alpha job job-1 failed with retryable parse error (attempt 2).');
  });
});
