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
import { providerOperationRuntimeMetaKey } from '#src/jobs/runtime-meta.js';
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
    ...overrides,
  };
}

/** Allocates and claims a real session, initializes a real job against it, and commits the W2.3 runtime-meta
 *  locator `verifyIdentity` requires — everything `applyProviderEventAtSeq`'s real port needs before it will
 *  apply a single event. */
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
  progressStore
    .getDb()
    .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run(
      providerOperationRuntimeMetaKey(jobId, OPERATION_ID),
      JSON.stringify({
        version: 1,
        jobId,
        operationId: OPERATION_ID,
        buildSetId: BUILD_SET_ID,
        hostFingerprint: 'a'.repeat(64),
        guardianInstanceId: randomUUID(),
        guardianPid: 100,
        guardianProcessStartedAtSeconds: 1,
        guardianControlEndpoint: '/tmp/guardian.sock',
        proxyInstanceId: PROXY_INSTANCE_ID,
        proxyPid: 200,
        reaperInstanceId: randomUUID(),
        reaperPid: 300,
        reaperProcessStartedAtSeconds: 2,
        reaperControlEndpoint: '/tmp/reaper.sock',
        containmentKind: 'detached-group',
        proxyProcessStartedAtSeconds: 3,
        proxyProcessGroupId: 200,
        canonicalEndpoint: '/tmp/proxy.sock',
        reservationId: randomUUID(),
        activationNonce: randomUUID(),
        providerRootPid: 400,
        providerRootProcessStartedAtSeconds: 4,
        jointContainmentReceipt: 'receipt-1',
        committedThroughProviderSeq: 0,
      }),
    );

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
    db: openTestStoreDb(runtime),
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

  it('serializes overlapping transactions instead of nesting BEGIN IMMEDIATE', async () => {
    // Two events genuinely arrive interleaved: the proxy runs a separate pump per operation over one socket,
    // and `control-client.ts` dispatches each inbound frame with `void serveInboundRequest(...)` rather than
    // awaiting it. This transaction is held open across an `await` — unlike the synchronous `withImmediate` —
    // so without serialization the second `BEGIN IMMEDIATE` lands inside the first and SQLite refuses it.
    const port = createStoreProviderEventEffectPort(testDeps());
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = port.runInTransaction(async () => {
      order.push('first:enter');
      await firstMayFinish;
      order.push('first:exit');
      return 'first';
    });
    const second = port.runInTransaction(async () => {
      order.push('second:enter');
      return 'second';
    });

    // The second must not have entered while the first was suspended mid-transaction.
    await Promise.resolve();
    expect(order).toEqual(['first:enter']);

    releaseFirst();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter']);
  });

  it('keeps serving after a failed transaction rather than wedging every later one behind it', async () => {
    const port = createStoreProviderEventEffectPort(testDeps());

    await expect(
      port.runInTransaction(async () => {
        throw new Error('effect failed');
      }),
    ).rejects.toThrow('effect failed');

    // A rejected link must not poison the chain: the queue is what every later event waits on.
    await expect(port.runInTransaction(async () => 'after')).resolves.toBe('after');
  });

  it('propagates the original failure, not a secondary error from a ROLLBACK that itself throws', async () => {
    const port = createStoreProviderEventEffectPort(testDeps());
    const originalFailure = new Error('effect failed');
    const rollbackFailure = new Error('rollback boom');
    const db = progressStore.getDb();
    const realExec = db.exec.bind(db);
    const execSpy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackFailure;
      return realExec(sql);
    });

    try {
      // Strict identity, not just message: the operator must see the effect failure that actually caused the
      // rollback, not a distinct error object minted for the rollback itself. (A real ROLLBACK failure leaves
      // the underlying connection genuinely mid-transaction — unlike an ordinary effect failure, there is no
      // expectation the chain keeps serving afterward; only which error surfaces is this fix's contract.)
      await expect(
        port.runInTransaction(async () => {
          throw originalFailure;
        }),
      ).rejects.toBe(originalFailure);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('applies a progress event, advances the watermark, and appends it to the job journal', async () => {
    const { identity } = seedOperation();
    const port = createStoreProviderEventEffectPort(testDeps());

    const result = await port.runInTransaction(async (tx) => {
      const verified = await port.verifyIdentity(tx, identity);
      expect(verified).toBe(true);
      const watermark = await port.readWatermark(tx, identity);
      expect(watermark).toBe(0);
      await port.appendProgress(tx, identity, 1, { kind: 'progress', message: 'thinking' });
      await port.advanceWatermark(tx, identity, 1);
      return 'done';
    });

    expect(result).toBe('done');
    const events = progressStore.readJobEvents(identity.jobId);
    expect(events.some((event) => event.type === 'progress')).toBe(true);
  });

  it('releases the session claim atomically with a direct terminal', async () => {
    const { identity, sessionId } = seedOperation();
    const port = createStoreProviderEventEffectPort(testDeps());

    await port.runInTransaction(async (tx) => {
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
      return undefined;
    });

    expect(progressStore.readTerminalProjection(identity.jobId)).not.toBeNull();
    expect(readSession(sessionId)?.activeJobId).toBeUndefined();
  });

  it('deletes the operation runtime-meta locator in the same transaction as the terminal it commits', async () => {
    const { identity } = seedOperation();
    const port = createStoreProviderEventEffectPort(testDeps());
    const readMetaRow = () =>
      progressStore
        .getDb()
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(providerOperationRuntimeMetaKey(identity.jobId, identity.operationId));

    expect(readMetaRow()).not.toBeUndefined();

    await port.runInTransaction(async (tx) => {
      await port.appendJobTerminal(tx, identity, 1, {
        kind: 'direct',
        body: {
          kind: 'terminal',
          terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
          diagnostics: {},
        },
      });
      await port.releaseSessionClaim(tx, identity);
      // `advanceWatermark` before the release: it still reads and rewrites this exact row, so releasing any
      // earlier in the same transaction would make that read fail (`applyProviderEventAtSeq` enforces this
      // same order for every real terminal/suspended event).
      await port.advanceWatermark(tx, identity, 1);
      await port.releaseOperationLocator(tx, identity);
      return undefined;
    });

    // Finding 5: this delete used to run only from the in-process `settled` callback (`coordinator/index.ts`),
    // strictly after this whole transaction had already committed — a crash in that gap stranded the row
    // permanently. It is proven gone here, immediately after the transaction that committed the terminal,
    // with no separate `settled()` call in between.
    expect(readMetaRow()).toBeUndefined();
  });

  it('rolls back the operation runtime-meta delete together with the terminal when a later step fails', async () => {
    const { identity } = seedOperation();
    const port = createStoreProviderEventEffectPort(testDeps());
    const readMetaRow = () =>
      progressStore
        .getDb()
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(providerOperationRuntimeMetaKey(identity.jobId, identity.operationId));

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
        await port.releaseOperationLocator(tx, identity);
        throw new Error('boom after locator release');
      }),
    ).rejects.toThrow('boom after locator release');

    // The delete is plain SQL against the same `BEGIN IMMEDIATE` transaction, not a second, independent write
    // — a `ROLLBACK` after it undoes it exactly as it undoes the terminal event and watermark advance it ran
    // alongside.
    expect(readMetaRow()).not.toBeUndefined();
    expect(progressStore.readTerminalProjection(identity.jobId)).toBeNull();
  });

  it('threads the recorded interruption trigger into a truthful session.interrupted, linked to its terminal', async () => {
    const { identity, sessionId } = seedOperation();
    const port = createStoreProviderEventEffectPort(testDeps());

    await port.runInTransaction(async (tx) => {
      await port.appendSessionInterrupted(tx, identity, 1, 'handoff');
      await port.appendJobTerminal(tx, identity, 1, { kind: 'interrupted' });
      await port.releaseSessionClaim(tx, identity);
      return undefined;
    });

    const interrupted = rawEventsByType(sessionId, 'session.interrupted')[0];
    expect((interrupted?.body as { trigger?: string } | undefined)?.trigger).toBe('handoff');
    const terminal = progressStore.readTerminalProjection(identity.jobId);
    expect(terminal?.outcome.kind).toBe('failed');
    expect(readSession(sessionId)?.activeJobId).toBeUndefined();
  });

  it('rolls back every effect and the watermark together when a later step fails', async () => {
    const { identity } = seedOperation();
    const port = createStoreProviderEventEffectPort(testDeps());

    await expect(
      port.runInTransaction(async (tx) => {
        await port.appendProgress(tx, identity, 1, { kind: 'progress', message: 'first' });
        await port.advanceWatermark(tx, identity, 1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(progressStore.readJobEvents(identity.jobId).some((event) => event.type === 'progress')).toBe(false);
    const meta = progressStore
      .getDb()
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(providerOperationRuntimeMetaKey(identity.jobId, identity.operationId)) as { value: string } | undefined;
    expect(
      meta && (JSON.parse(meta.value) as { committedThroughProviderSeq: number }).committedThroughProviderSeq,
    ).toBe(0);
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
  });

  it('refuses a suspended event with no recorded operation.stop.v1 cause rather than guessing one', async () => {
    const { identity } = seedOperation();
    const handler = createProviderEventHandler(testDeps({ recordedStopCauseFor: () => null }));

    await expect(
      handler({ operation: identity, providerSeq: 1, event: { kind: 'suspended', reason: 'interrupt_unconfirmed' } }),
    ).rejects.toThrow(/no recorded operation\.stop\.v1 cause/u);
  });
});
