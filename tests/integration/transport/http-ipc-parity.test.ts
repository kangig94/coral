import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpHandler } from '#src/transport/http/handler.js';
import { closeIpcServer, createIpcServer, ipcAdapter, listenIpcServer } from '#src/transport/ipc/server.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { kbSourceCreateRequestSchema } from '#src/kb/tool-contracts.js';
import { testPrincipal } from '../../helpers/principal.js';
import {
  TEST_PROVIDER_SCOPE,
  TEST_SYSTEM_PROVIDER_SCOPE,
  withTestProfileLocation,
} from '../../helpers/provider-credentials.js';

const tempDirs: string[] = [];
const httpServers: Server[] = [];

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-http-ipc-parity-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

function createPorts(): HttpHandlerPorts {
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
      scopeCheck: vi.fn(() => ({ valid: [], missing: [], mismatch: [] })),
      abort: vi.fn(),
      waitStream: vi.fn(),
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
    expansion: {
      equipExpansion: vi.fn(),
      unequipExpansion: vi.fn(),
      removeExpansionCatalog: vi.fn(async () => ({ status: 'removed' as const })),
      listExpansion: vi.fn(async () => ({ expansions: [] })),
      readBinding: vi.fn(async () => ({ bound: false })),
    },
  };
}

async function startHttpServer(ports: HttpHandlerPorts): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    void createHttpHandler(ports)(req, res);
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('http/ipc parity', () => {
  it('preserves the explicit IPC caller scope independently of the configured system scope', async () => {
    const spec = rpcCatalog.find((entry) => entry.name === 'sessions.create');
    if (!spec) throw new Error('sessions.create spec not found');

    const ports: HttpHandlerPorts = {
      ...createPorts(),
      systemProviderScope: withTestProfileLocation(
        TEST_SYSTEM_PROVIDER_SCOPE,
        'claude',
        '/accounts/system-claude',
      ) as typeof TEST_SYSTEM_PROVIDER_SCOPE,
    };
    let observedContext: Parameters<NonNullable<typeof ports.sessions.start>>[2] | undefined;
    ports.sessions.start = vi.fn(async (_providerName, _input, ctx) => {
      observedContext = ctx;
      return { kind: 'provider-session' as const, status: 'running' as const, jobId: 'job-1', sessionId: 'session-1' };
    });

    await ipcAdapter(spec, ports).dispatch(
      {
        provider: 'claude',
        prompt: 'hello',
        projectRoot: '/project-root',
        providerScope: withTestProfileLocation(TEST_PROVIDER_SCOPE, 'claude', '/accounts/caller-claude'),
      },
      testPrincipal({ transport: 'ipc' }),
    );

    expect(observedContext?.providerScope).toEqual(
      withTestProfileLocation(TEST_PROVIDER_SCOPE, 'claude', '/accounts/caller-claude'),
    );
  });

  it('rejects a system-origin scope supplied over IPC', async () => {
    const spec = rpcCatalog.find((entry) => entry.name === 'sessions.create');
    if (!spec) throw new Error('sessions.create spec not found');
    const ports = createPorts();

    await expect(
      ipcAdapter(spec, ports).dispatch(
        {
          provider: 'claude',
          prompt: 'hello',
          projectRoot: '/project-root',
          providerScope: TEST_SYSTEM_PROVIDER_SCOPE,
        },
        testPrincipal({ transport: 'ipc' }),
      ),
    ).resolves.toEqual({
      kind: 'unary',
      statusCode: 400,
      body: { code: 'invalid_request', message: 'invalid request' },
    });
    expect(ports.sessions.start).not.toHaveBeenCalled();
  });

  it('uses only the configured named system scope for HTTP provider work', async () => {
    const spec = rpcCatalog.find((entry) => entry.name === 'sessions.create');
    if (!spec) throw new Error('sessions.create spec not found');
    const ports = createPorts();
    let observedScope: unknown;
    ports.sessions.start = vi.fn(async (_providerName, _input, ctx) => {
      observedScope = ctx.providerScope;
      return {
        kind: 'provider-session' as const,
        status: 'running' as const,
        jobId: 'job-system',
        sessionId: 'session-system',
      };
    });

    await ipcAdapter(spec, ports).dispatch(
      { provider: 'claude', prompt: 'hello', projectRoot: '/project-root' },
      testPrincipal({ transport: 'http' }),
    );

    expect(observedScope).toEqual(TEST_SYSTEM_PROVIDER_SCOPE);
  });

  it.each([
    {
      name: 'session',
      path: '/sessions',
      body: { provider: 'codex', prompt: 'hello', projectRoot: '/project-root' },
      allocation: (ports: HttpHandlerPorts) => ports.sessions.start,
    },
    {
      name: 'workflow',
      path: '/workflow',
      body: { expression: 'architect@codex', startPrompt: 'hello', projectRoot: '/project-root' },
      allocation: (ports: HttpHandlerPorts) => ports.workflows.execute,
    },
    {
      name: 'discussion',
      path: '/discuss/sessions',
      body: {
        projectRoot: '/project-root',
        topic: 'Should we ship?',
        agents: [
          { name: 'alpha', persona: '# Alpha' },
          { name: 'beta', persona: '# Beta' },
        ],
      },
      allocation: (ports: HttpHandlerPorts) => ports.discuss.start,
    },
  ])('rejects HTTP $name allocation when the daemon system scope is absent', async ({ path, body, allocation }) => {
    const { systemProviderScope: _systemProviderScope, ...ports } = createPorts();
    const { baseUrl } = await startHttpServer(ports);

    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': ports.identity.token,
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'system_provider_scope_unconfigured',
      message: 'Provider execution is disabled because this Coral daemon has no named system provider scope.',
      remediation: 'Configure CORAL_SYSTEM_PROVIDER_SCOPE on the daemon and restart it.',
    });
    expect(allocation(ports)).not.toHaveBeenCalled();
  });

  it('derives invocation principal from the transport boundary', async () => {
    const spec = rpcCatalog.find((entry) => entry.name === 'sessions.create');
    if (!spec) {
      throw new Error('sessions.create spec not found');
    }

    const observedPrincipals: Array<{ subject: string; transport: string; binding: unknown }> = [];
    const ports = createPorts();
    ports.sessions.start = vi.fn(async (_providerName, _input, ctx) => {
      observedPrincipals.push({
        subject: ctx.principal.subject,
        transport: ctx.principal.transport,
        binding: ctx.principal.binding,
      });
      return {
        kind: 'provider-session' as const,
        status: 'running' as const,
        jobId: `job-${observedPrincipals.length}`,
        sessionId: `session-${observedPrincipals.length}`,
      };
    });

    const request = {
      provider: 'codex',
      prompt: 'hello',
      projectRoot: '/project-root',
    };
    const ipcResult = await ipcAdapter(spec, ports).dispatch(request, testPrincipal({ transport: 'ipc' }));

    expect(ipcResult.kind).toBe('unary');
    expect(observedPrincipals).toEqual([
      { subject: 'operator', transport: 'ipc', binding: { kind: 'project', root: '/project-root' } },
    ]);

    const { baseUrl } = await startHttpServer(ports);
    const httpResponse = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': ports.identity.token,
      },
      body: JSON.stringify(request),
    });

    expect(httpResponse.status).toBe(201);
    expect(await httpResponse.json()).toMatchObject({
      launchState: 'running',
      jobId: 'job-2',
      sessionId: 'session-2',
    });
    expect(observedPrincipals).toEqual([
      { subject: 'operator', transport: 'ipc', binding: { kind: 'project', root: '/project-root' } },
      { subject: 'operator', transport: 'http', binding: { kind: 'project', root: '/project-root' } },
    ]);
  });

  it('rejects client-supplied source-import authority while deriving an HTTP project principal', async () => {
    const bypassRequest = {
      filePath: '../outside.md',
      projectRoot: '/project-root',
      authority: 'admin',
    };
    expect(kbSourceCreateRequestSchema.safeParse(bypassRequest).success).toBe(false);

    const ports = createPorts();
    const observedPrincipals: Array<{ subject: string; transport: string; binding: unknown }> = [];
    ports.kb.createSource = vi.fn(async (_args, ctx) => {
      observedPrincipals.push({
        subject: ctx.principal.subject,
        transport: ctx.principal.transport,
        binding: ctx.principal.binding,
      });
      return {
        ok: true as const,
        data: {
          status: 'completed',
          observedPrincipal: {
            subject: ctx.principal.subject,
            transport: ctx.principal.transport,
            binding: ctx.principal.binding,
          },
        },
      };
    });
    const { baseUrl } = await startHttpServer(ports);

    const rejectedResponse = await fetch(`${baseUrl}/kb/sources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': ports.identity.token,
      },
      body: JSON.stringify(bypassRequest),
    });

    expect(rejectedResponse.status).toBe(400);
    expect(ports.kb.createSource).not.toHaveBeenCalled();

    const acceptedResponse = await fetch(`${baseUrl}/kb/sources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': ports.identity.token,
      },
      body: JSON.stringify({ filePath: '../outside.md', projectRoot: '/project-root' }),
    });

    expect(acceptedResponse.status).toBe(201);
    expect(await acceptedResponse.json()).toEqual({
      status: 'completed',
      observedPrincipal: {
        subject: 'operator',
        transport: 'http',
        binding: { kind: 'project', root: '/project-root' },
      },
    });
    expect(observedPrincipals).toEqual([
      { subject: 'operator', transport: 'http', binding: { kind: 'project', root: '/project-root' } },
    ]);
    expect(ports.kb.createSource).toHaveBeenCalledWith(
      { filePath: '../outside.md', readiness: 'base-search', async: false },
      expect.objectContaining({
        principal: expect.objectContaining({
          subject: 'operator',
          transport: 'http',
          binding: { kind: 'project', root: '/project-root' },
        }),
        projectRoot: '/project-root',
      }),
    );
  });

  it('returns the same coordinator RPC payload through HTTP and IPC after wire normalization', async () => {
    const ports = createPorts();
    const socketPath = makeSocketPath();
    const ipcListener = createIpcServer(ports);
    const { baseUrl } = await startHttpServer(ports);

    await listenIpcServer(ipcListener, socketPath);
    try {
      const httpResponse = await fetch(`${baseUrl}/discuss/sessions`, {
        headers: { 'X-Coral-Backend-Token': ports.identity.token },
      });
      const httpBody = await httpResponse.json();
      const ipcBody = await requestIpcMethod(
        socketPath,
        'discuss.session.list',
        {},
        {
          auth: { kind: 'boot', token: 'test-boot-token' },
        },
      );

      expect(httpBody).toEqual(ipcBody);
    } finally {
      await closeIpcServer(ipcListener);
    }
  });
});
