import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createHttpHandler } from '#src/transport/http/handler.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { TEST_SYSTEM_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';

// S8: HTTP token comparison must be constant-time. Direct `===` leaks
// information about the token prefix through completion-time variance for any
// network gateway. Spec §11.3.

const httpServers: Server[] = [];

function createPorts(): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'test-token-with-many-bytes',
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
      listSessions: vi.fn(() => []),
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
});

describe('http token comparison (S8)', () => {
  it('rejects requests with the wrong token using constant-time comparison', async () => {
    const ports = createPorts();
    const baseUrl = await startHttpServer(ports);

    const wrongLength = await fetch(`${baseUrl}/discuss/sessions`, {
      headers: { 'X-Coral-Backend-Token': 'too-short' },
    });
    expect(wrongLength.status).toBe(401);

    const sameLengthDifferentBytes = await fetch(`${baseUrl}/discuss/sessions`, {
      headers: { 'X-Coral-Backend-Token': 'XXXX-token-with-many-bytes' },
    });
    expect(sameLengthDifferentBytes.status).toBe(401);
  });

  it('accepts requests with the correct token', async () => {
    const ports = createPorts();
    const baseUrl = await startHttpServer(ports);

    const ok = await fetch(`${baseUrl}/discuss/sessions`, {
      headers: { 'X-Coral-Backend-Token': ports.identity.token },
    });
    expect(ok.status).toBe(200);
  });

  it('rejects requests with no token header', async () => {
    const ports = createPorts();
    const baseUrl = await startHttpServer(ports);

    const noHeader = await fetch(`${baseUrl}/discuss/sessions`);
    expect(noHeader.status).toBe(401);
  });
});
