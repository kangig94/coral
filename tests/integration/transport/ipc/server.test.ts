import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { TEST_SYSTEM_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { IdleTimer } from '#src/coordinator/live/idle.js';
import { createRealTimePort } from '#src/infra/time.js';
import { domainSuccess } from '#src/transport/tool-result.js';
import { ChildPrincipalRegistry, type ChildPrincipalCredential } from '#src/coordinator/child-principal-registry.js';
import { createStoreChildPrincipalCredentials } from '#src/coordinator/child-principal-credentials.js';
import { childPrincipalAuthFromEnv } from '#src/transport/ipc/child-principal-auth.js';
import { CORAL_CHILD_CREDENTIAL_ID, CORAL_CHILD_CREDENTIAL_KEY } from '#src/security/child-principal-env.js';
import type { ChildProvenRequest } from '#src/security/child-credential.js';
import type { Capability } from '#src/security/capability.js';
import type { Database } from '#src/store/db.js';
import { childCredentialDatabase } from '#tests/helpers/child-principal-registry.js';
import { testPrincipal } from '#tests/helpers/principal.js';

const tempDirs: string[] = [];

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-server-test-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

async function connectRawIpcSocket(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => undefined);
  return socket;
}

function createPorts(): HttpHandlerPorts {
  const requestDrain = vi.fn();

  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'unused-for-ipc',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
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
      requestDrain,
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
        uptimeMs: 1,
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
      scopeCheck: vi.fn(() => ({ valid: [], missing: [], mismatch: [] })),
      abort: vi.fn(),
      admitWait: vi.fn((req: { jobIds: string[] }) =>
        req.jobIds.map((jobId) => ({ jobId, disposition: 'admitted' as const })),
      ),
      snapshot: vi.fn(),
      waitHandoverSignal: vi.fn(() => new AbortController().signal),
      waitStream: vi.fn(),
      list: vi.fn(() => []),
      detail: vi.fn(() => null),
      unknownJobDisposition: vi.fn(() => 'not-found' as const),
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
      listSessions: vi.fn(() => [
        {
          sessionId: 'session-1',
          projectRoot: '/project-root',
          topic: 'Parity topic',
          status: 'setup' as const,
          createdAt: '2026-04-20T00:00:00.000Z',
          agentCount: 2,
          authority: 'live' as const,
        },
      ]),
      loadDetail: vi.fn(),
      watch: vi.fn(),
      bid: vi.fn(),
      speech: vi.fn(),
      abort: vi.fn(),
    },
    recoveryQuarantine: {
      clear: vi.fn(async (request) => ({ ...request, disposition: 'advanced' as const })),
    },
    providerHosts: {
      list: vi.fn(),
      inspect: vi.fn(),
      evict: vi.fn(),
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

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ipc server', () => {
  it('serves and closes the same IPC surface at compatibility addresses', async () => {
    const ports = createPorts();
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();
    const compatibilityPaths = [makeSocketPath(), makeSocketPath()];

    await listenIpcServer(listener, socketPath, compatibilityPaths);
    try {
      for (const address of [socketPath, ...compatibilityPaths]) {
        await expect(requestIpcMethod(address, 'transport.ping')).resolves.toMatchObject({
          status: 'ok',
          instanceId: 'test-instance',
        });
      }
    } finally {
      await closeIpcServer(listener);
    }

    expect([socketPath, ...compatibilityPaths].some(existsSync)).toBe(false);
  });

  it('forwards an already-open partial frame without changing its bytes', async () => {
    const listener = createIpcServer(createPorts());
    const socketPath = makeSocketPath();
    await listenIpcServer(listener, socketPath);
    const observed = new Promise<void>((resolve) => {
      listener.server.once('connection', (socket) => socket.once('data', () => resolve()));
    });
    const client = createConnection(socketPath);
    const forwarded: Socket[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      });
      const partial = Buffer.from('{"jsonrpc":"2.0","method":"transport.ping","id":"\xc3', 'latin1');
      client.write(partial);
      await observed;
      const received = new Promise<Buffer>((resolve) => {
        listener.forwardConnections!((socket, pendingFrameBase64) => {
          forwarded.push(socket);
          resolve(Buffer.from(pendingFrameBase64, 'base64'));
        });
      });
      expect(await received).toEqual(partial);
    } finally {
      for (const socket of forwarded) socket.destroy();
      client.destroy();
      await closeIpcServer(listener);
    }
  });

  it('holds an explicit drain until an IPC unary request settles', async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const ports = createPorts();
    const idleTimer = new IdleTimer({ time: createRealTimePort() });
    const onIdle = vi.fn();
    ports.admin.beginRequest = () => idleTimer.beginRequest();
    ports.admin.endRequest = () => idleTimer.endRequest();
    ports.kb.readSearch = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return domainSuccess({ results: [] });
    });
    idleTimer.startWatching(() => false, onIdle);

    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();
    await listenIpcServer(listener, socketPath);
    const request = requestIpcMethod(
      socketPath,
      'kb.entries.search',
      { q: 'held' },
      { auth: { kind: 'boot', token: 'boot-token' } },
    );

    try {
      await entered.promise;
      idleTimer.requestDrain('test-teardown');

      expect(onIdle).not.toHaveBeenCalled();

      release.resolve();
      await expect(request).resolves.toEqual({ results: [] });
      expect(onIdle).toHaveBeenCalledExactlyOnceWith('test-teardown');
    } finally {
      release.resolve();
      await request.catch(() => undefined);
      idleTimer.stopWatching();
      await closeIpcServer(listener);
    }
  });

  describe('challenged child authentication', () => {
    type ChallengedAuth = Extract<NonNullable<ReturnType<typeof childPrincipalAuthFromEnv>>, { kind: 'challenged' }>;
    type CapturedProof = Readonly<{ auth: ReturnType<ChallengedAuth['prove']>; request: ChildProvenRequest }>;

    /** Each call is a separate coordinator incarnation over the same store. */
    function registryOn(db: Database): ChildPrincipalRegistry {
      return new ChildPrincipalRegistry(
        { randomBytes },
        createStoreChildPrincipalCredentials(() => db),
        {
          namespace: 'test-namespace',
          activeJobOrigin: () => 'test-namespace',
        },
      );
    }

    function issue(registry: ChildPrincipalRegistry, caps: readonly Capability[] = ['jobs:read', 'kb:read']) {
      return registry.register({
        issuer: 'durable-job',
        parentPrincipal: testPrincipal(),
        childCaps: caps,
        namespace: 'test-namespace',
        parentJobId: 'job-a',
        parentSessionId: 'session-a',
        nowMs: 0,
      });
    }

    /** The auth a launched child's CLI derives from its environment. */
    function childAuth(credential: ChildPrincipalCredential, captured: CapturedProof[] = []): ChallengedAuth {
      const auth = childPrincipalAuthFromEnv({
        [CORAL_CHILD_CREDENTIAL_ID]: credential.credentialId,
        [CORAL_CHILD_CREDENTIAL_KEY]: credential.privateKey,
        CORAL_JOB_ID: credential.parentJobId,
        CORAL_SESSION_ID: credential.parentSessionId,
      });
      if (auth === null || auth === undefined || typeof auth === 'function')
        throw new Error('Expected challenged auth');
      return {
        kind: 'challenged',
        prove: (challenge, request) => {
          const proof = auth.prove(challenge, request);
          captured.push({ auth: proof, request });
          return proof;
        },
      };
    }

    /** Sends each frame on one connection and collects one answer per frame. */
    async function exchange(socketPath: string, frames: readonly Record<string, unknown>[]): Promise<unknown[]> {
      const socket = await connectRawIpcSocket(socketPath);
      try {
        const answers: unknown[] = [];
        let buffered = '';
        let deliver: (line: string) => void = () => undefined;
        socket.on('data', (chunk) => {
          buffered += chunk.toString();
          for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            deliver(line);
          }
        });
        for (const frame of frames) {
          const line = await new Promise<string>((resolve) => {
            deliver = resolve;
            socket.write(`${JSON.stringify(frame)}\n`);
          });
          answers.push(JSON.parse(line) as unknown);
        }
        return answers;
      } finally {
        socket.destroy();
      }
    }

    function replayFrame(proof: CapturedProof): Record<string, unknown> {
      return {
        kind: 'request',
        id: proof.request.id,
        method: proof.request.method,
        ...(proof.request.params === undefined ? {} : { params: proof.request.params }),
        auth: proof.auth,
      };
    }

    async function serve(registry: ChildPrincipalRegistry, overrides: Partial<HttpHandlerPorts> = {}) {
      const listener = createIpcServer({ ...createPorts(), childPrincipals: registry, ...overrides });
      const socketPath = makeSocketPath();
      await listenIpcServer(listener, socketPath);
      return { listener, socketPath };
    }

    it('should refuse one proof reused for a second request', async () => {
      const registry = registryOn(childCredentialDatabase());
      const captured: CapturedProof[] = [];
      const { listener, socketPath } = await serve(registry);
      try {
        await expect(
          requestIpcMethod(socketPath, 'jobs.list', {}, { auth: childAuth(issue(registry), captured) }),
        ).resolves.toEqual({ jobs: [] });
        const proof = captured[0];
        if (proof === undefined) throw new Error('Expected a captured proof');

        const [withoutChallenge] = await exchange(socketPath, [replayFrame(proof)]);
        const [, underFreshChallenge] = await exchange(socketPath, [
          { kind: 'request', id: 'challenge', method: 'transport.challenge' },
          replayFrame(proof),
        ]);

        for (const answer of [withoutChallenge, underFreshChallenge]) {
          expect(answer).toMatchObject({ kind: 'error', error: { data: { code: 'unauthorized' } } });
        }
      } finally {
        await closeIpcServer(listener);
      }
    });

    it('should re-authenticate a child that stays alive across succession against the successor', async () => {
      const db = childCredentialDatabase();
      const incumbent = registryOn(db);
      const auth = childAuth(issue(incumbent));
      const first = await serve(incumbent);
      try {
        await expect(requestIpcMethod(first.socketPath, 'jobs.list', {}, { auth })).resolves.toEqual({ jobs: [] });
      } finally {
        await closeIpcServer(first.listener);
      }

      const readSearch = vi.fn(async () => domainSuccess({ results: [] }));
      const basePorts = createPorts();
      const successor = await serve(registryOn(db), { kb: { ...basePorts.kb, readSearch } });
      try {
        await expect(
          requestIpcMethod(successor.socketPath, 'kb.entries.search', { q: 'carried work' }, { auth }),
        ).resolves.toEqual({ results: [] });
        expect(readSearch).toHaveBeenCalledOnce();
      } finally {
        await closeIpcServer(successor.listener);
      }
    });
  });

  it('rejects IPC connections across addresses at the process-wide socket cap', async () => {
    const ports = createPorts();
    const listener = createIpcServer(ports, {
      firstFrameTimeoutMs: 60_000,
      maxOpenSockets: 1,
      writeDrainTimeoutMs: 10,
    });
    const socketPath = makeSocketPath();
    const compatibilitySocketPath = makeSocketPath();
    let first: Socket | null = null;
    let second: Socket | null = null;

    await listenIpcServer(listener, socketPath, [compatibilitySocketPath]);
    try {
      const accepted = new Promise<void>((resolve) => listener.server.once('connection', () => resolve()));
      first = await connectRawIpcSocket(socketPath);
      await accepted;
      second = createConnection(compatibilitySocketPath);
      const refusal = await new Promise<unknown>((resolve, reject) => {
        let buffered = '';
        second!.on('data', (chunk) => {
          buffered += chunk.toString();
          if (buffered.includes('\n')) resolve(JSON.parse(buffered.trim()));
        });
        second!.once('error', reject);
      });
      expect(refusal).toMatchObject({
        kind: 'error',
        error: { data: { code: 'too_many_ipc_connections' } },
      });
    } finally {
      first?.destroy();
      second?.destroy();
      await closeIpcServer(listener);
    }
  });
});
