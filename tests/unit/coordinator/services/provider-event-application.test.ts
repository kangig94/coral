import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { createRealRuntime } from '#src/runtime/real.js';
import { JobStore } from '#src/jobs/store.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { allocateTestSession } from '#tests/helpers/session.js';
import { SessionManager } from '#src/sessions/shell.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { ProviderBindingCatalog } from '#src/providers/catalog.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { ProviderOperationEventIdentity } from '#src/jobs/provider-event.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import {
  compareAndSwapProviderOperation,
  insertProviderOperation,
  readProviderOperation,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import {
  createProviderEventHandler,
  createStoreProviderEventEffectPort,
  type ProviderEventApplicationDeps,
} from '#src/coordinator/services/provider-event-application.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-provider-event-application-test-tmp-${process.pid}`,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => mockState.tmpHome, tmpdir: () => mockState.tmpRoot };
});

const BUILD_SET_ID = randomUUID();
const PROXY_INSTANCE_ID = randomUUID();
const OPERATION_ID = randomUUID();
const BACKEND_NAMESPACE = 'test-ns';

let runtime: ReturnType<typeof createRealRuntime>;
let progressStore: JobStore;
let sessionManager: SessionManager;

function testAppendContext() {
  return {
    now: () => new Date(runtime.time.now()),
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
    bodyCodec: progressStore.bodyCodec,
    providers: permissiveProviderLookupPort,
  };
}

/** A fake catalog whose `rehydrateBinding` always answers a `BoundProvider` whose `decodeContinuity` accepts
 *  any JSON-record value unchanged. Real provider-specific decoding is `providers/`' concern, not this
 *  port's; this fake exists only so `appendSessionEvent`'s `continuity` branch has something to call. */
function fakeCatalog(options: { decodeFails?: boolean } = {}): ProviderBindingCatalog {
  const bound = {
    decodeContinuity: (raw: unknown) =>
      options.decodeFails === true
        ? { ok: false as const, failure: { provider: 'codex', reason: 'invalid-persisted-binding' } }
        : { ok: true as const, value: raw === null ? undefined : raw },
  } as unknown as BoundProvider;
  return {
    get: () => undefined,
    getAll: () => [],
    decodeScope: () => {
      throw new Error('not used by this port');
    },
    decodeCompleteScope: () => {
      throw new Error('not used by this port');
    },
    bindFromScope: async () => {
      throw new Error('not used by this port');
    },
    bindProfile: async () => {
      throw new Error('not used by this port');
    },
    rehydrateBinding: () => ({ ok: true, value: bound }),
    renderBindingFailure: () => 'binding failure',
  };
}

function testDeps(overrides: Partial<ProviderEventApplicationDeps> = {}): ProviderEventApplicationDeps {
  return {
    db: progressStore.getDb(),
    progressStore,
    appendContext: testAppendContext(),
    providerRegistry: fakeCatalog(),
    runtime,
    emitSessionReleased: () => {},
    recordedStopCauseFor: () => null,
    operations: { settled: () => {} },
    observeCommitted: () => {},
    ...overrides,
  };
}

/** Allocates a claimed job and its executing saga. */
function seedOperation(): { jobId: string; sessionId: string; identity: ProviderOperationEventIdentity } {
  const jobId = randomUUID();
  const session = allocateTestSession(
    sessionManager,
    'codex',
    'agent',
    undefined,
    '/project',
    '/project',
    BACKEND_NAMESPACE,
  );
  sessionManager.claimForJobSync(session.sessionId, jobId);
  progressStore.initJob({
    jobId,
    sessionId: session.sessionId,
    provider: 'codex',
    projectRoot: '/project',
    backendNamespace: BACKEND_NAMESPACE,
  });

  const identity: ProviderOperationEventIdentity = {
    jobId,
    operationId: OPERATION_ID,
    proxyInstanceId: PROXY_INSTANCE_ID,
    buildSetId: BUILD_SET_ID,
  };
  insertProviderOperation(progressStore.getDb(), providerOperationRecord('executing', { operation: identity }));

  return { jobId, sessionId: session.sessionId, identity };
}

function readSession(sessionId: string): ProviderSession | null {
  return sessionManager.get('codex', sessionId);
}

/** `JobStore.readJobEvents` only ever returns `job.progress.emitted`/`job.terminal.recorded` (normalized to
 *  `'progress'`/`'terminal'`), so proving `session.interrupted` landed means reading the raw journal. Its
 *  stream is the *session*, not the job (`sessionFaultEvent`), so callers pass the session id. */
function rawEventsByType(streamId: string, type: string): { body: unknown }[] {
  return (
    progressStore
      .getDb()
      .prepare('SELECT body FROM events WHERE stream_id = ? AND type = ? ORDER BY seq ASC')
      .all(streamId, type) as { body: Uint8Array }[]
  ).map((row) => ({ body: JSON.parse(Buffer.from(row.body).toString('utf8')) as unknown }));
}

beforeEach(() => {
  mockState.tmpHome = `${mockState.tmpRoot}/${randomUUID()}`;
  runtime = createRealRuntime('dev');
  const eventBus = new TypedEventBus();
  progressStore = new JobStore(BACKEND_NAMESPACE, runtime, createEventBodyCodec(), {
    db: openTestStoreDb(runtime, ':memory:'),
    eventBus,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
  });
  sessionManager = SessionManager.forProduction(
    '/project',
    runtime,
    (cb) => progressStore.commit(cb),
    () => {},
    { db: progressStore.getDb() },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStoreProviderEventEffectPort', () => {
  it('serializes across separate ports sharing one connection, not just within one port', async () => {
    // `buildProviderEventHandler` is called once per proxy set, and each call builds its own port — while
    // every one of them closes over the same store connection. Two sets is the ordinary case, since Claude
    // and Codex are distinct executable identities. A chain scoped to a port would leave each set serialized
    // against itself and against nothing else, so set B's `BEGIN IMMEDIATE` would land inside set A's open
    // transaction and SQLite would refuse it. The exclusivity belongs to the connection, so the chain must.
    const first = createStoreProviderEventEffectPort(testDeps());
    const second = createStoreProviderEventEffectPort(testDeps());
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const a = first.runInTransaction(async () => {
      order.push('a:enter');
      await firstMayFinish;
      order.push('a:exit');
      return 'a';
    });
    const b = second.runInTransaction(async () => {
      order.push('b:enter');
      return 'b';
    });

    await Promise.resolve();
    expect(order).toEqual(['a:enter']);

    releaseFirst();
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter']);
  });

  it('rolls back the settlement tombstone together with terminal effects and the final watermark', async () => {
    const { identity } = seedOperation();
    const port = createStoreProviderEventEffectPort(testDeps());

    await expect(
      port.runInTransaction(async (tx) => {
        await port.appendJobTerminal(tx, identity, 1, {
          kind: 'direct',
          body: {
            kind: 'terminal',
            terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
            diagnostics: {},
          },
        });
        await port.releaseSessionClaim(tx, identity);
        await port.advanceWatermark(tx, identity, 1);
        await port.markSettlementPending(tx, identity, 1);
        throw new Error('boom after settlement intent');
      }),
    ).rejects.toThrow('boom after settlement intent');

    expect(progressStore.readTerminalProjection(identity.jobId)).toBeNull();
    expect(readProviderOperation(progressStore.getDb(), identity)).toMatchObject({
      phase: 'executing',
      committedThroughProviderSeq: 0,
    });
  });

  it('does not hand a rolled-back terminal to the post-commit observer', async () => {
    const { identity } = seedOperation();
    const observeCommitted = vi.fn();
    const port = createStoreProviderEventEffectPort(testDeps({ observeCommitted }));

    await expect(
      port.runInTransaction(async (tx) => {
        await port.appendJobTerminal(tx, identity, 1, {
          kind: 'direct',
          body: {
            kind: 'terminal',
            terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
            diagnostics: {},
          },
        });
        throw new Error('boom before commit');
      }),
    ).rejects.toThrow('boom before commit');

    expect(observeCommitted).not.toHaveBeenCalled();
  });
});

describe('createProviderEventHandler', () => {
  it('acknowledges only after the durable commit, and effect-free acks a seq already applied', async () => {
    const { identity } = seedOperation();
    const handler = createProviderEventHandler(testDeps());

    const first = await handler({ operation: identity, providerSeq: 1, event: { kind: 'progress', message: 'a' } });
    expect(first).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });

    const replayed = await handler({ operation: identity, providerSeq: 1, event: { kind: 'progress', message: 'a' } });
    expect(replayed).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });
    // Effect-free: exactly one progress event exists, not two.
    expect(progressStore.readJobEvents(identity.jobId).filter((event) => event.type === 'progress')).toHaveLength(1);
  });

  it('replays a terminal whose ACK was lost while retaining its settlement tombstone', async () => {
    const { identity } = seedOperation();
    const handler = createProviderEventHandler(testDeps());
    const request = {
      operation: identity,
      providerSeq: 1,
      event: {
        kind: 'terminal' as const,
        terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' as const } },
        diagnostics: {},
      },
    };

    expect(await handler(request)).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });
    expect(await handler(request)).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });

    expect(progressStore.readJobEvents(identity.jobId).filter((event) => event.type === 'terminal')).toHaveLength(1);
    expect(readProviderOperation(progressStore.getDb(), identity)).toMatchObject({
      phase: 'settlement-pending',
      terminalProviderSeq: 1,
    });
  });

  it('requests replay from the current watermark on a sequence gap, writing nothing', async () => {
    const { identity } = seedOperation();
    const handler = createProviderEventHandler(testDeps());

    const result = await handler({ operation: identity, providerSeq: 5, event: { kind: 'progress', message: 'a' } });

    expect(result).toEqual({ kind: 'replay', replayFromProviderSeq: 1, reason: 'sequence_gap' });
    expect(progressStore.readJobEvents(identity.jobId).some((event) => event.type === 'progress')).toBe(false);
  });

  it('rejects an event naming a proxy instance this locator never committed', async () => {
    const { identity } = seedOperation();
    const handler = createProviderEventHandler(testDeps());

    await expect(
      handler({
        operation: { ...identity, proxyInstanceId: randomUUID() },
        providerSeq: 1,
        event: { kind: 'progress', message: 'a' },
      }),
    ).rejects.toThrow();
  });

  it('answers a suspended event with the coordinator-recorded stop cause, not a default', async () => {
    const { identity, sessionId } = seedOperation();
    const handler = createProviderEventHandler(testDeps({ recordedStopCauseFor: () => 'restart' }));

    const result = await handler({
      operation: identity,
      providerSeq: 1,
      event: { kind: 'suspended', reason: 'interrupt_unconfirmed' },
    });

    expect(result).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });
    const interrupted = rawEventsByType(sessionId, 'session.interrupted')[0];
    expect((interrupted?.body as { trigger?: string } | undefined)?.trigger).toBe('restart');
    expect(readSession(sessionId)?.activeJobId).toBeUndefined();
    expect(readProviderOperation(progressStore.getDb(), identity)?.phase).toBe('settlement-pending');
  });

  it('refuses a suspended event with no recorded operation.stop.v1 cause rather than guessing one', async () => {
    const { identity } = seedOperation();
    const handler = createProviderEventHandler(testDeps({ recordedStopCauseFor: () => null }));

    await expect(
      handler({ operation: identity, providerSeq: 1, event: { kind: 'suspended', reason: 'interrupt_unconfirmed' } }),
    ).rejects.toThrow(/no recorded operation\.stop\.v1 cause/u);
  });

  it.each([
    [
      'terminal',
      {
        kind: 'terminal' as const,
        terminal: { content: 'provider result', durationMs: 5, outcome: { kind: 'completed' as const } },
        diagnostics: {},
      },
    ],
    ['suspended', { kind: 'suspended' as const, reason: 'interrupt_unconfirmed' as const }],
  ])('converts a %s acknowledgement under re-key containment into a failed terminal', async (_label, event) => {
    const { identity, sessionId } = seedOperation();
    const executing = readProviderOperation(progressStore.getDb(), identity);
    if (executing?.phase !== 'executing') throw new Error('expected executing operation');
    const contained = providerOperationRecordSchema.parse({
      ...executing,
      controlIntent: {
        kind: 'rekey-refusal-containment',
        cause: 'coordinator_rekey_refused',
        reason: 'The receiver refused the prepared source reservation.',
        requestedAt: '2026-08-09T12:34:56.000Z',
      },
      revision: executing.revision + 1,
    });
    if (contained.phase !== 'executing') throw new Error('expected contained executing operation');
    expect(compareAndSwapProviderOperation(progressStore.getDb(), executing, contained).kind).toBe('updated');

    const handler = createProviderEventHandler(testDeps());
    await expect(handler({ operation: identity, providerSeq: 1, event })).resolves.toEqual({
      kind: 'ack',
      committedThroughProviderSeq: 1,
    });

    expect(progressStore.readTerminalProjection(identity.jobId)?.outcome.kind).toBe('failed');
    expect(rawEventsByType(sessionId, 'session.interrupted')).toEqual([]);
    expect(readSession(sessionId)?.activeJobId).toBeUndefined();
    expect(readProviderOperation(progressStore.getDb(), identity)).toMatchObject({
      phase: 'settlement-pending',
      controlIntent: contained.controlIntent,
    });
  });
});
