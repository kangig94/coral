import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decode, encode, type JsonRpcRequestEnvelope } from '#src/transport/ipc/json-rpc.js';
import { requestIpcMethod, subscribeIpcMethod } from '#src/transport/ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import type { HealthSnapshot, HttpHandlerPorts } from '#src/transport/server-ports.js';
import { TEST_PROVIDER_CREDENTIALS } from '../helpers/provider-credentials.js';

function requestEnvelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'request', id: 1, method: 'coordinator.listExpansion', ...payload });
}

async function withCapturedIpcRequest(
  respond: (request: JsonRpcRequestEnvelope, socket: Socket) => void,
  run: (socketPath: string) => Promise<unknown>,
): Promise<JsonRpcRequestEnvelope> {
  const dir = mkdtempSync(join(tmpdir(), 'coral-ipc-auth-'));
  const socketPath = join(dir, 'daemon.sock');
  const server = createServer();
  let capturedResolve: ((request: JsonRpcRequestEnvelope) => void) | null = null;
  const captured = new Promise<JsonRpcRequestEnvelope>((resolveCaptured) => {
    capturedResolve = resolveCaptured;
  });

  server.on('connection', (socket) => {
    socket.once('data', (chunk) => {
      const frame = String(chunk).trim();
      const request = decode(frame);
      if (request.kind !== 'request') {
        throw new Error('expected request frame');
      }
      capturedResolve?.(request);
      respond(request, socket);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socketPath, resolveListen);
  });

  try {
    await run(socketPath);
    return await captured;
  } finally {
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

function healthSnapshot(): HealthSnapshot {
  return {
    status: 'ok',
    kernel: { phase: 'running', readyAt: 1 },
    version: '0.5.2',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    namespace: 'test-namespace',
    instanceId: 'test-instance',
    pid: 12345,
    processStartedAt: 1_700_000_000,
    uptimeMs: 10,
    active: 0,
    activeJobs: 0,
    liveDiscuss: 0,
    queueDepth: 0,
    inflightRequests: 0,
    textProjectionState: 'idle',
    env: {},
    components: [],
  };
}

function createPorts(): HttpHandlerPorts {
  let drainRequested = false;
  return {
    identity: {
      pluginRoot: '/plugin',
      token: 'backend-token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
      version: '0.5.2',
      bundleHash: 'bundle-hash',
      flavor: 'prod',
      namespace: 'test-namespace',
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    providerCredentialDefaults: TEST_PROVIDER_CREDENTIALS,
    ambientClaudeLocation: {
      locate: () => ({ configDirLocator: '/home/user/.claude', projectsRoot: '/home/user/.claude/projects' }),
    },
    admin: {
      getLifecycleState: () => (drainRequested ? 'draining' : 'running'),
      isLifecycleRunning: () => !drainRequested,
      isDrainRequested: () => drainRequested,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: vi.fn(() => {
        drainRequested = true;
      }),
    },
    health: { read: healthSnapshot },
    events: {
      bus: {} as never,
      addResponse: vi.fn(),
      removeResponse: vi.fn(),
      createStreamId: () => 'stream-id',
      nowIsoString: () => '2026-04-20T00:00:00.000Z',
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    sessions: { start: vi.fn() },
    jobs: {
      scopeCheck: vi.fn(() => ({ valid: [], missing: [], mismatch: [] })),
      abort: vi.fn(),
      waitStream: vi.fn(),
      list: vi.fn(() => []),
      detail: vi.fn(() => null),
    },
    workflows: { execute: vi.fn() },
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
      removeExpansionCatalog: vi.fn(),
      listExpansion: vi.fn(),
      readBinding: vi.fn(),
    },
  };
}

async function withRealIpcServer(run: (socketPath: string, ports: HttpHandlerPorts) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'coral-ipc-auth-server-'));
  const socketPath = join(dir, 'daemon.sock');
  const ports = createPorts();
  const listener = createIpcServer(ports);
  await listenIpcServer(listener, socketPath);

  try {
    await run(socketPath, ports);
  } finally {
    await closeIpcServer(listener);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('IPC auth metadata invariant', () => {
  it('accepts only closed, validated auth metadata on JSON-RPC requests', () => {
    expect(decode(requestEnvelope({ auth: { kind: 'boot', token: 'boot-token' } }))).toMatchObject({
      kind: 'request',
      auth: { kind: 'boot', token: 'boot-token' },
    });
    expect(
      decode(
        requestEnvelope({
          auth: {
            kind: 'child',
            handle: 'handle',
            token: 'child-token',
            jobId: 'job-a',
            sessionId: 'session-a',
          },
        }),
      ),
    ).toMatchObject({
      kind: 'request',
      auth: {
        kind: 'child',
        handle: 'handle',
        token: 'child-token',
        jobId: 'job-a',
        sessionId: 'session-a',
      },
    });

    expect(() => decode(requestEnvelope({ auth: { kind: 'boot', token: '' } }))).toThrow();
    expect(() => decode(requestEnvelope({ auth: { kind: 'boot', token: 'x', extra: true } }))).toThrow();
    expect(() => decode(requestEnvelope({ auth: { kind: 'shutdown', token: 'x' } }))).toThrow();
    expect(() => decode(requestEnvelope({ auth: { kind: 'child', token: 'x' } }))).toThrow();
    expect(() =>
      decode(requestEnvelope({ auth: { kind: 'child', handle: 'handle', token: 'x', jobId: 'job-a' } })),
    ).toThrow();
  });

  it('attaches auth metadata to unary and subscription client envelopes', async () => {
    const unary = await withCapturedIpcRequest(
      (request, socket) => {
        socket.end(`${encode({ kind: 'response', id: request.id, result: { ok: true } })}\n`);
      },
      async (socketPath) => {
        await requestIpcMethod(socketPath, 'coordinator.listExpansion', {}, { auth: { kind: 'boot', token: 'boot' } });
      },
    );
    expect(unary.auth).toEqual({ kind: 'boot', token: 'boot' });

    const subscription = await withCapturedIpcRequest(
      (request, socket) => {
        socket.end(
          `${encode({
            kind: 'response',
            id: request.id,
            result: { status: 'subscribed', method: request.method },
          })}\n`,
        );
      },
      async (socketPath) => {
        const stream = await subscribeIpcMethod(socketPath, 'jobs.wait', {}, { auth: { kind: 'boot', token: 'boot' } });
        await stream.close();
      },
    );
    expect(subscription.auth).toEqual({ kind: 'boot', token: 'boot' });
  });

  it('gates operational IPC methods by boot token while leaving ping unauthenticated', async () => {
    await withRealIpcServer(async (socketPath, ports) => {
      await expect(requestIpcMethod(socketPath, 'transport.ping')).resolves.toMatchObject({
        status: 'ok',
        version: '0.5.2',
        namespace: 'test-namespace',
        pid: 12345,
      });

      await expect(requestIpcMethod(socketPath, 'transport.health')).rejects.toMatchObject({
        message: 'IPC boot token or child principal required',
      });
      await expect(
        requestIpcMethod(socketPath, 'transport.health', undefined, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).resolves.toMatchObject({
        status: 'ok',
        components: [],
      });

      await expect(requestIpcMethod(socketPath, 'transport.shutdown')).rejects.toMatchObject({
        message: 'Manual shutdown required: shutdown capability missing or invalid',
      });
      await expect(
        requestIpcMethod(socketPath, 'transport.shutdown', undefined, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).resolves.toEqual({ status: 'draining', instanceId: 'test-instance' });
      expect(ports.admin.requestDrain).toHaveBeenCalledWith('replaced');
    });
  });
});
