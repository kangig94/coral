import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSseBlock } from '#src/transport/http/sse.js';
import { parseWaitStreamEvent } from '#src/jobs/wait-stream-event.js';
import { serializeWaitCursor, type WaitStreamEvent } from '#src/jobs/wait.js';
import { createHttpHandler } from '#src/transport/http/handler.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { WaitStreamRequest } from '#src/jobs/wait.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import { TEST_SYSTEM_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';

const tempDirs: string[] = [];
const httpServers: HttpServer[] = [];
const waitTiming = {
  origin: 'runtime',
  originAt: '2026-07-03T08:00:00.000Z',
  emittedAt: '2026-07-03T08:00:02.000Z',
  elapsedMs: 2_000,
} as const;

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-subscription-carriage-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

function makeWaitEvents(): WaitStreamEvent[] {
  return [
    {
      type: 'queued',
      jobKind: 'provider',
      jobId: 'job-1',
      sessionId: 'session-1',
      queuePosition: 1,
      runningJobIds: [],
      timing: { ...waitTiming, origin: 'queued' },
    },
    { type: 'progress', jobId: 'job-1', seq: 5, message: 'working', timing: waitTiming },
    {
      type: 'terminal',
      jobId: 'job-1',
      seq: 6,
      remainingJobIds: [],
      resultPath: '/tmp/result.md',
      result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
    },
  ];
}

function createPorts(requests: WaitStreamRequest[]): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'test-token',
      bootToken: 'test-boot-token',
      shutdownToken: 'test-shutdown-token',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      namespace: 'test-namespace',
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    systemProviderScope: TEST_SYSTEM_PROVIDER_SCOPE,
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: vi.fn(),
    },
    health: {
      read: () => ({
        status: 'ok' as const,
        kernel: { phase: 'running' as const, readyAt: 0 },
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod' as const,
        namespace: 'test-namespace',
        instanceId: 'test-instance',
        pid: 12345,
        uptimeMs: 0,
        active: 0,
        activeJobs: 0,
        liveDiscuss: 0,
        queueDepth: 0,
        inflightRequests: 0,
        textProjectionState: 'idle',
        env: {},
        components: [{ id: 'kb', phase: 'online' as const }],
      }),
    },
    events: {
      bus: {} as never,
      addResponse: vi.fn(),
      removeResponse: vi.fn(),
      createStreamId: () => 'stream-id',
      nowIsoString: () => '2026-04-20T00:00:00.000Z',
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    sessions: {
      start: vi.fn(),
    },
    jobs: {
      scopeCheck: vi.fn(() => ({ valid: ['job-1'], missing: [], mismatch: [] })),
      abort: vi.fn(),
      waitStream: vi.fn(async function* (request: WaitStreamRequest) {
        requests.push(request);
        for (const event of makeWaitEvents()) {
          yield event;
        }
      }),
      list: vi.fn(() => []),
      detail: vi.fn(() => null),
    },
    workflows: {
      execute: vi.fn(),
    },
    kb: {
      readSearch: vi.fn(),
      diagnose: vi.fn(),
      readNote: vi.fn(),
      readSource: vi.fn(),
      readCommunity: vi.fn(),
      listStaleCommunities: vi.fn(),
      readCommunitySummaryInput: vi.fn(),
      setCommunitySummary: vi.fn(),
      readWiki: vi.fn(),
      readMemo: vi.fn(),
      readPrinciple: vi.fn(),
      listSources: vi.fn(),
      listWikis: vi.fn(),
      listMemos: vi.fn(),
      listPrinciples: vi.fn(),
      createNote: vi.fn(),
      updateNote: vi.fn(),
      deleteNote: vi.fn(),
      createWiki: vi.fn(),
      rewriteWiki: vi.fn(),
      linkWiki: vi.fn(),
      unlinkWiki: vi.fn(),
      citeWiki: vi.fn(),
      adoptWiki: vi.fn(),
      deleteWiki: vi.fn(),
      wakeUp: vi.fn(),
      createSource: vi.fn(),
      deleteSource: vi.fn(),
      createMemo: vi.fn(),
      deleteMemos: vi.fn(),
      reindex: vi.fn(),
    },
    discuss: {
      seed: vi.fn(),
      start: vi.fn(),
      listSessions: vi.fn(() => []),
      loadDetail: vi.fn(),
      watch: vi.fn(),
      bid: vi.fn(),
      speech: vi.fn(),
      abort: vi.fn(),
    },
    expansion: {
      equipExpansion: vi.fn(),
      unequipExpansion: vi.fn(),
      removeExpansionCatalog: vi.fn(async () => ({ status: 'removed' as const })),
      listExpansion: vi.fn(async () => ({ expansions: [] })),
      readBinding: vi.fn(async () => ({ bound: false })),
    },
  };
}

async function startHttpServer(ports: HttpHandlerPorts): Promise<string> {
  const server = createServer((req, res) => {
    void createHttpHandler(ports)(req, res);
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('subscription carriage', () => {
  it('carries the scripted jobs.wait stream over IPC with the subscription primitive', async () => {
    const requests: WaitStreamRequest[] = [];
    const ports = createPorts(requests);
    const socketPath = makeSocketPath();
    const listener = createIpcServer(ports);
    const expectedCursor = { afterSeq: 4 };

    await listenIpcServer(listener, socketPath);
    try {
      const subscription = await createIpcClient(socketPath, undefined, {
        kind: 'boot',
        token: 'test-boot-token',
      }).subscribe<ReturnType<typeof makeWaitEvents>[number]>('jobs.wait', {
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        timeoutSeconds: 30,
        cursor: expectedCursor,
      });
      const received: Array<ReturnType<typeof makeWaitEvents>[number]> = [];

      for await (const event of subscription) {
        received.push(event);
      }

      expect(received).toEqual(makeWaitEvents());
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        timeoutSeconds: 30,
        cursor: expectedCursor,
      });
      expect(Object.getOwnPropertyDescriptor(requests[0], 'abortSignal')?.value).toBeInstanceOf(AbortSignal);
    } finally {
      await closeIpcServer(listener);
    }
  });

  it('detaches the server-side data listener after accepting a subscription handshake', async () => {
    const requests: WaitStreamRequest[] = [];
    const ports = createPorts(requests);
    let release = () => {};
    const holdStreamOpen = new Promise<void>((resolve) => {
      release = resolve;
    });

    ports.jobs.waitStream = vi.fn(async function* (request: WaitStreamRequest) {
      requests.push(request);
      yield makeWaitEvents()[0];
      await holdStreamOpen;
    });

    const socketPath = makeSocketPath();
    const listener = createIpcServer(ports);

    await listenIpcServer(listener, socketPath);
    try {
      const subscription = await createIpcClient(socketPath, undefined, {
        kind: 'boot',
        token: 'test-boot-token',
      }).subscribe<ReturnType<typeof makeWaitEvents>[number]>('jobs.wait', {
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        timeoutSeconds: 30,
      });

      expect(listener.sockets.size).toBe(1);
      const serverSocket = Array.from(listener.sockets)[0];
      expect(serverSocket?.listenerCount('data')).toBe(0);

      release();
      await subscription.close();
    } finally {
      release();
      await closeIpcServer(listener);
    }
  });

  it('projects the same scripted subscription sequence to HTTP SSE', async () => {
    const requests: WaitStreamRequest[] = [];
    const ports = createPorts(requests);
    const socketPath = makeSocketPath();
    const listener = createIpcServer(ports);
    const baseUrl = await startHttpServer(ports);
    const expectedCursor = { afterSeq: 4 };

    await listenIpcServer(listener, socketPath);
    try {
      const ipcSubscription = await createIpcClient(socketPath, undefined, {
        kind: 'boot',
        token: 'test-boot-token',
      }).subscribe<ReturnType<typeof makeWaitEvents>[number]>('jobs.wait', {
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        timeoutSeconds: 30,
        cursor: expectedCursor,
      });
      const ipcEvents: Array<ReturnType<typeof makeWaitEvents>[number]> = [];
      for await (const event of ipcSubscription) {
        ipcEvents.push(event);
      }

      const response = await fetch(`${baseUrl}/jobs/wait`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Last-Event-ID': serializeWaitCursor(expectedCursor),
          'X-Coral-Backend-Token': ports.identity.token,
        },
        body: JSON.stringify({
          jobIds: ['job-1'],
          projectRoot: '/tmp/project',
          timeoutSeconds: 30,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const body = await response.text();
      const httpEvents = body
        .split('\n\n')
        .map((block) => parseSseBlock(block))
        .filter((block): block is NonNullable<typeof block> => block !== null)
        .map((block) => parseWaitStreamEvent(block.event, block.data))
        .filter((event): event is NonNullable<typeof event> => event !== null);

      expect(httpEvents).toEqual(ipcEvents);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        jobIds: ['job-1'],
        projectRoot: '/tmp/project',
        timeoutSeconds: 30,
        cursor: expectedCursor,
      });
      expect(Object.getOwnPropertyDescriptor(requests[1], 'abortSignal')?.value).toBeInstanceOf(AbortSignal);
    } finally {
      await closeIpcServer(listener);
    }
  });
});
