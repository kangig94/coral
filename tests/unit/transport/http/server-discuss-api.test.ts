import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage as ClientIncomingMessage } from 'node:http';

import { makeEvent } from '#src/discuss/events.js';
import type { DiscussDetailResponse, DiscussSummaryDto } from '#src/discuss/read-contract.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import {
  createDiscussContextRegistry,
  get as getDiscussContext,
  type DiscussContextRegistry,
} from '#src/discuss/shell/live-registry.js';
import { attachSession } from '#src/discuss/shell/registry.js';
import { submitManualSpeech } from '#src/discuss/shell/operations.js';
import { type CoordinatorServerController, createCoordinatorServer } from '#src/coordinator/index.js';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { JobStore } from '#src/jobs/store.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import {
  appendPersistedEvents,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  persistSession,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';

type HttpStream = {
  response: ClientIncomingMessage;
  waitForText: (check: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
  close: () => void;
};

type TestServerController = Pick<
  CoordinatorServerController,
  'server' | 'start' | 'shutdown' | 'waitForShutdown' | 'getLifecycle'
>;

function createStoreServices(progressStore: JobStore): CoordinatorStoreServices {
  return {
    storeDb: progressStore.getDb(),
    progressStore,
    expansionManifestCatalog: {} as never,
    expansionStateStore: {} as never,
    expansionLifecycleService: null,
    consumerDriver: null,
  };
}

function extractSsePayload(text: string, eventName: string): Record<string, unknown> | null {
  for (const block of text.split('\n\n')) {
    if (!block.includes(`event: ${eventName}`)) continue;
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (dataLine) return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
  }
  return null;
}

async function openHttpStream(url: string, headers: Record<string, string>): Promise<HttpStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers });
    req.once('error', reject);
    req.once('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });

      const waitForText = (check: (current: string) => boolean, timeoutMs = 2_000): Promise<string> => {
        if (check(text)) return Promise.resolve(text);

        return new Promise<string>((resolveText, rejectText) => {
          const timeout = setTimeout(() => {
            cleanup();
            rejectText(new Error('Timed out reading stream'));
          }, timeoutMs);
          const onData = () => {
            if (check(text)) {
              cleanup();
              resolveText(text);
            }
          };
          const onEnd = () => {
            cleanup();
            rejectText(new Error('Stream ended before expected data arrived'));
          };
          const onError = (err: Error) => {
            cleanup();
            rejectText(err);
          };
          const cleanup = () => {
            clearTimeout(timeout);
            response.off('data', onData);
            response.off('end', onEnd);
            response.off('error', onError);
          };
          response.on('data', onData);
          response.once('end', onEnd);
          response.once('error', onError);
        });
      };

      resolve({
        response,
        waitForText,
        close: () => {
          req.destroy();
          response.destroy();
        },
      });
    });
    req.end();
  });
}

// SimulationRuntime's time port uses virtual time that never advances on its
// own. The backend shutdown sequence (waitForInflightDrain, sleep-based
// timeouts) relies on wall-clock progress, so we replace the entire time port
// with real Node.js timers. Every handle is `.unref()`'d so they don't block
// vitest from exiting.
function realTimePort(): Runtime['time'] {
  return {
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout: (handle) => {
      if (handle) clearTimeout(handle as NodeJS.Timeout);
    },
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref();
      return t;
    },
    clearInterval: (handle) => {
      if (handle) clearInterval(handle as NodeJS.Timeout);
    },
  };
}

describe('server discuss API', () => {
  let controller: TestServerController | null = null;

  afterEach(async () => {
    if (!controller) return;

    controller.server.closeAllConnections?.();

    if (controller.getLifecycle() !== 'stopped') {
      try {
        await controller.shutdown('test');
      } catch {
        /* best effort */
      }
    }

    controller.server.close();
    controller.server.unref();
    controller = null;
    cleanupDiscussHarnesses();
    vi.restoreAllMocks();
  });

  async function startServer(
    projectRoot: string,
    registry: DiscussContextRegistry,
    service = createExecutionServiceStub(),
    runtime?: Runtime,
    resolveProjectSourceFn?: (projectRoot: string) => string,
    progressStore?: JobStore,
  ): Promise<{ baseUrl: string; token: string; registry: DiscussContextRegistry }> {
    if (progressStore) {
      if (!runtime) {
        throw new Error('startServer with progressStore requires its matching runtime');
      }
      const effectiveRuntime = runtime ? { ...runtime, time: realTimePort() } : undefined;
      const core = createCoordinatorCore({
        runtime: effectiveRuntime as Runtime,
        resolveProjectSourceFn,
        bootSnapshot: {
          instanceId: 'server-discuss-api-test',
          token: 'test-token',
          version: '9.9.9',
          bundleHash: 'test-hash',
          flavor: 'prod',
          log: () => {},
        },
        discussRegistry: registry,
        createExecutionService: () => service as never,
        createServerFn: (handler) => createServer(handler),
        closeServerFn: async (server) => {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
        runStartupRecoveryFn: async () => [],
        getConsumerStuck: () => [],
        getMutationBlocked: () => ({ blocked: false }),
      });
      setStoreServicesForTest(core.storeServicesRef, createStoreServices(progressStore), { storeDbPath: ':memory:' });
      const liveSessions = [...registry.contexts.entries()].flatMap(([projectRoot, context]) =>
        [...context.sessions.values()].map((session) => ({
          projectRoot,
          snapshot: session.snapshot,
          watchBuffer: session.watchBuffer,
          abortEnded: session.abortEnded,
        })),
      );
      registry.contexts.clear();
      for (const session of liveSessions) {
        const ctx = core.getDiscussContext({
          projectRoot: session.projectRoot,
          pluginRoot: core.identity.pluginRoot,
          coralEnv: {},
        });
        attachSession(ctx, session.snapshot, session.watchBuffer, session.abortEnded);
      }
      core.runtimeState.setLifecycle('kernel-ready');
      core.runtimeState.setLifecycle('running');
      core.runtimeState.setStartedAt(Date.now());
      const port = await new Promise<number>((resolve, reject) => {
        core.server.once('error', reject);
        core.server.listen(0, '127.0.0.1', () => {
          core.server.off('error', reject);
          const address = core.server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('server did not bind to a TCP port'));
            return;
          }
          resolve(address.port);
        });
      });
      controller = {
        server: core.server,
        start: async () => ({
          port,
          host: '127.0.0.1',
          token: 'test-token',
          socketPath: '',
          version: '9.9.9',
          bundleHash: 'test-hash',
          flavor: 'prod',
          namespace: core.identity.namespace,
          instanceId: 'server-discuss-api-test',
          startedAt: Date.now(),
        }),
        shutdown: (reason) => core.lifecycleController.shutdown(reason),
        waitForShutdown: () => core.lifecycleController.waitForShutdown(),
        getLifecycle: () => core.runtimeState.getLifecycle(),
      };
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test-token',
        registry,
      };
    }

    controller = createCoordinatorServer({
      runtime: runtime ? { ...runtime, time: realTimePort() } : undefined,
      resolveProjectSourceFn,
      bootSnapshot: {
        instanceId: 'server-discuss-api-test',
        token: 'test-token',
        version: '9.9.9',
        bundleHash: 'test-hash',
        flavor: 'prod',
        log: () => {},
      },
      discussRegistry: registry,
      createExecutionService: () => service as never,
      createKbSubsystemFn: async () => ({
        kb: {} as never,
        readDb: {} as never,
        curateScheduler: {
          start: async () => {},
          schedule: () => {},
          scheduleDeferredCommit: () => {},
          isRunning: () => false,
          stop: async () => {},
        },
      }),
    });
    const started = await controller.start();
    return {
      baseUrl: `http://127.0.0.1:${started.port}`,
      token: started.token,
      registry,
    };
  }

  it('serves control and audit detail views from the committed snapshot contract', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'ended-session',
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-11T00:01:00.000Z',
          { agent: 'alpha', score: 88, thought: 'keep sealed' },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-11T00:01:01.000Z',
          { agent: 'beta', score: 42, thought: 'also sealed' },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-11T00:01:02.000Z',
          {
            allBids: { alpha: 88, beta: 42 },
            effectiveBids: { alpha: 88, beta: 42 },
            thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 4,
          'speech.recorded',
          '2026-03-11T00:01:03.000Z',
          {
            agent: 'alpha',
            content: 'Open the street to buses and bikes first.',
            decrementQuota: true,
            recordLastSpeechStep: 1,
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 5,
          'session.ended',
          '2026-03-11T00:01:04.000Z',
          { endReason: 'all_below_threshold', endReasonContent: 'Consensus reached.' },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 6,
          'session.synthesized',
          '2026-03-11T00:01:05.000Z',
          { synthesis: 'Build the transit-first pilot and measure results.' },
        ),
      ],
    });

    await persistSession(harness, {
      sessionId: 'live-session',
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-11T00:02:00.000Z',
          { agent: 'alpha', score: 40, thought: 'alpha' },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-11T00:02:01.000Z',
          { agent: 'user', score: 80, thought: 'user' },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-11T00:02:02.000Z',
          {
            allBids: { alpha: 40, user: 80 },
            effectiveBids: { alpha: 40, user: 80 },
            thoughts: { alpha: 'alpha', user: 'user' },
            outcome: { winner: 'user', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
      ],
    });

    const backend = await startServer(
      harness.projectRoot,
      createDiscussContextRegistry(),
      harness.service,
      harness.runtime,
      undefined,
      harness.progressStore,
    );

    const controlResponse = await fetch(
      `${backend.baseUrl}/discuss/sessions/ended-session?projectRoot=${encodeURIComponent(harness.projectRoot)}`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );
    const controlBody = (await controlResponse.json()) as DiscussDetailResponse;

    expect(controlResponse.status).toBe(200);
    expect(controlBody.view).toBe('control');
    expect(controlBody.authority).toBe('persisted');
    expect(Array.isArray(controlBody.transcript)).toBe(true);
    expect('transcript' in controlBody.session).toBe(false);
    expect(controlBody.transcript.find((entry) => entry.type === 'bids')).toEqual({
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: '2026-03-11T00:01:02.000Z',
      winner: 'alpha',
      resolve_type: 'normal',
    });
    expect(JSON.stringify(controlBody.transcript)).not.toContain('keep sealed');

    const auditResponse = await fetch(
      `${backend.baseUrl}/discuss/sessions/ended-session?projectRoot=${encodeURIComponent(harness.projectRoot)}&view=audit`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );
    const auditBody = (await auditResponse.json()) as DiscussDetailResponse;

    expect(auditResponse.status).toBe(200);
    expect(auditBody.view).toBe('audit');
    expect(auditBody.transcript.find((entry) => entry.type === 'bids')).toMatchObject({
      type: 'bids',
      bids: { alpha: 88, beta: 42 },
      effective_bids: { alpha: 88, beta: 42 },
      thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
    });

    const liveAuditResponse = await fetch(
      `${backend.baseUrl}/discuss/sessions/live-session?projectRoot=${encodeURIComponent(harness.projectRoot)}&view=audit`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );

    expect(liveAuditResponse.status).toBe(409);
    expect(await liveAuditResponse.json()).toEqual({
      code: 'audit_requires_ended_session',
      message: 'Audit requires ended session',
    });
  });

  it('loads discuss detail from another checkout of the same source', async () => {
    const sharedSource = 'test-org/shared-repo';
    const firstHarness = createDiscussHarness(createExecutionServiceStub(), sharedSource);
    const secondHarness = createDiscussHarness(createExecutionServiceStub(), sharedSource);
    const snapshot = await persistSession(firstHarness, { sessionId: 'shared-session' });
    attachSession(firstHarness.context, snapshot);
    const registry = createDiscussContextRegistry();
    registry.contexts.set(firstHarness.projectRoot, firstHarness.context);

    const backend = await startServer(
      secondHarness.projectRoot,
      registry,
      secondHarness.service,
      firstHarness.runtime,
      () => sharedSource,
      firstHarness.progressStore,
    );

    const response = await fetch(
      `${backend.baseUrl}/discuss/sessions/shared-session?projectRoot=${encodeURIComponent(secondHarness.projectRoot)}`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );
    const body = (await response.json()) as DiscussDetailResponse;

    expect(response.status).toBe(200);
    expect(body.authority).toBe('live');
    expect(body.session.projectRoot).toBe(firstHarness.projectRoot);
    expect(body.session.sessionId).toBe('shared-session');
  });

  it('dedupes same-source sessions across different project roots in GET /discuss/sessions', async () => {
    const sharedSource = 'test-org/shared-repo';
    const firstHarness = createDiscussHarness(createExecutionServiceStub(), sharedSource);
    const secondHarness = createDiscussHarness(createExecutionServiceStub(), sharedSource);
    // Persist the base session into both stores so each context's store stays
    // consistent with its attached snapshot (prevents infinite stale retry in
    // appendRuntimeEvents during shutdown).
    await persistSession(firstHarness, { sessionId: 'shared-session' });
    await persistSession(secondHarness, { sessionId: 'shared-session' });

    // Append an extra event only to firstHarness so it has the higher seq and
    // wins the dedup (the server's own projectRoot should be preferred).
    const firstSnapshot = await appendPersistedEvents(firstHarness, 'shared-session', (current) => [
      makeEvent(
        current.sessionId,
        secondHarness.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        'bid.submitted',
        '2026-03-11T00:02:30.000Z',
        { agent: 'alpha', score: 61, thought: 'alt checkout update' },
      ),
    ]);
    const secondSnapshot = secondHarness.store.load('shared-session')!;

    const registry = createDiscussContextRegistry();
    const backend = await startServer(
      firstHarness.projectRoot,
      registry,
      firstHarness.service,
      firstHarness.runtime,
      () => sharedSource,
      firstHarness.progressStore,
    );
    attachSession(secondHarness.context, secondSnapshot);
    attachSession(firstHarness.context, firstSnapshot);
    registry.contexts.set(secondHarness.projectRoot, secondHarness.context);
    registry.contexts.set(firstHarness.projectRoot, firstHarness.context);

    const response = await fetch(`${backend.baseUrl}/discuss/sessions`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = (await response.json()) as { sessions: DiscussSummaryDto[] };
    const sharedSessions = body.sessions.filter((s) => s.sessionId === 'shared-session');

    expect(response.status).toBe(200);
    expect(sharedSessions).toHaveLength(1);
    expect(sharedSessions[0]).toMatchObject({
      sessionId: 'shared-session',
      authority: 'live',
    });
    expect([firstHarness.projectRoot, secondHarness.projectRoot]).toContain(sharedSessions[0].projectRoot);
  });

  it('emits discuss:updated over SSE and detail reads observe the emitted lastSeq', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'manual-live-session',
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-11T00:03:00.000Z',
          { agent: 'alpha', score: 40, thought: 'alpha' },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-11T00:03:01.000Z',
          { agent: 'user', score: 80, thought: 'user' },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-11T00:03:02.000Z',
          {
            allBids: { alpha: 40, user: 80 },
            effectiveBids: { alpha: 40, user: 80 },
            thoughts: { alpha: 'alpha', user: 'user' },
            outcome: { winner: 'user', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
      ],
    });

    const registry = createDiscussContextRegistry();
    attachSession(harness.context, snapshot);
    registry.contexts.set(harness.projectRoot, harness.context);
    const backend = await startServer(
      harness.projectRoot,
      registry,
      harness.service,
      harness.runtime,
      undefined,
      harness.progressStore,
    );
    const context = getDiscussContext(registry, harness.projectRoot);
    if (!context) throw new Error('Expected recovered discuss context');

    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});

    const stream = await openHttpStream(`${backend.baseUrl}/events/stream`, {
      'X-Coral-Backend-Token': backend.token,
    });

    try {
      await stream.waitForText((text) => text.includes('event: ready'));
      await submitManualSpeech(context, 'manual-live-session', 'user', 'I will take the floor manually.', harness.ctx);

      const eventText = await stream.waitForText((text) => text.includes('event: discuss:updated'));
      const payload = extractSsePayload(eventText, 'discuss:updated');

      expect(payload).toEqual({
        projectRoot: harness.projectRoot,
        sessionId: 'manual-live-session',
        lastSeq: harness.store.load('manual-live-session')?.lastAppliedSeq,
        status: harness.store.load('manual-live-session')?.state.status,
      });

      const detailResponse = await fetch(
        `${backend.baseUrl}/discuss/sessions/manual-live-session?projectRoot=${encodeURIComponent(harness.projectRoot)}`,
        { headers: { 'X-Coral-Backend-Token': backend.token } },
      );
      const detailBody = (await detailResponse.json()) as DiscussDetailResponse;

      expect(detailResponse.status).toBe(200);
      expect(detailBody.lastSeq).toBe(payload?.lastSeq);
    } finally {
      stream.close();
    }
  });
});
