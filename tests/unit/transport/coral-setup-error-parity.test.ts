import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  documentedCoralSetupError,
  serializeCoralSetupError,
  type DocumentedCoralSetupErrorCode,
  type SerializedCoralSetupError,
} from '#src/runtime/errors.js';
import { buildTransportErrorResponse } from '#src/transport/error-response.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { createHttpHandler, sendJson } from '#src/transport/http/handler.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import { TEST_SYSTEM_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';

const tempDirs: string[] = [];
const httpServers: Server[] = [];

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-setup-error-parity-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

const ADDED_DOCUMENTED_SETUP_ERRORS = [
  { code: 'unknown_expansion', context: { name: 'needle' } },
  { code: 'expansion_runtime_unavailable', context: { name: 'needle' } },
  { code: 'engine_env_var_missing', context: { engine: 'gemini', envVar: 'GEMINI_API_KEY' } },
  { code: 'consumer_not_registered', context: { id: 'consumer-a' } },
  {
    code: 'consumer_authority_mismatch',
    context: { id: 'consumer-a', expected: 'journal', actual: 'corpus' },
  },
  { code: 'consumer_interest_mismatch', context: { id: 'consumer-a' } },
  {
    code: 'consumer_registration_kind_mismatch',
    context: { id: 'consumer-a', expected: 'base', actual: 'expansion' },
  },
  { code: 'consumer_lane_invalid', context: { id: 'consumer-a' } },
  { code: 'consumer_wait_unsupported', context: { id: 'consumer-a' } },
  { code: 'consumer_unregister_requires_stop', context: { id: 'consumer-a' } },
  { code: 'consumer_interest_invalid', context: { id: 'consumer-a' } },
  { code: 'consumer_registration_kind_invalid', context: { id: 'consumer-a' } },
] satisfies Array<{
  code: DocumentedCoralSetupErrorCode;
  context: Record<string, unknown>;
}>;

function documentedSetupErrorPayload(
  code: DocumentedCoralSetupErrorCode,
  context: Record<string, unknown>,
): SerializedCoralSetupError {
  const payload = serializeCoralSetupError(documentedCoralSetupError(code, context));
  if (payload === null) {
    throw new Error(`Expected ${code} to serialize`);
  }
  return payload;
}

function createPorts(failWith: () => Error): HttpHandlerPorts {
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
      listSessions: vi.fn(() => []),
      loadDetail: vi.fn(),
      watch: vi.fn(),
      bid: vi.fn(),
      speech: vi.fn(),
      abort: vi.fn(),
    },
    expansion: {
      equipExpansion: vi.fn(async () => {
        throw failWith();
      }),
      unequipExpansion: vi.fn(),
      removeExpansionCatalog: vi.fn(async () => ({ status: 'removed' as const })),
      listExpansion: vi.fn(async () => ({ expansions: [] })),
      readBinding: vi.fn(async () => ({ bound: false })),
    },
  };
}

async function startHttpServer(ports: HttpHandlerPorts): Promise<{ baseUrl: string }> {
  const handler = createHttpHandler(ports);
  const server = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      if (!res.headersSent) {
        const response = buildTransportErrorResponse(error);
        sendJson(res, response.statusCode, response.body);
        return;
      }
      res.destroy();
    });
  });

  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }

  return {
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

async function requestIpcErrorPayload(
  socketPath: string,
  expected: SerializedCoralSetupError,
): Promise<SerializedCoralSetupError> {
  try {
    await requestIpcMethod(
      socketPath,
      'coordinator.equipExpansion',
      { name: 'needle' },
      {
        auth: { kind: 'boot', token: 'test-boot-token' },
      },
    );
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(expected.userMessage);
    const structured = serializeCoralSetupError(error instanceof Error ? error.cause : null);
    expect(structured).not.toBeNull();
    return structured as SerializedCoralSetupError;
  }

  throw new Error('Expected IPC request to fail');
}

async function requestHttpErrorPayload(
  baseUrl: string,
  token: string,
  expected: SerializedCoralSetupError,
): Promise<SerializedCoralSetupError> {
  const response = await fetch(`${baseUrl}/coordinator/expansion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Coral-Backend-Token': token,
    },
    body: JSON.stringify({ name: 'needle' }),
  });

  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toMatchObject(expected);
  const structured = serializeCoralSetupError(body);
  expect(structured).not.toBeNull();
  return structured as SerializedCoralSetupError;
}

describe('coral setup error parity', () => {
  it.each(ADDED_DOCUMENTED_SETUP_ERRORS)(
    'surfaces $code through IPC and HTTP with matching setup payloads',
    async ({ code, context }) => {
      const ports = createPorts(() => documentedCoralSetupError(code, context));
      const expected = documentedSetupErrorPayload(code, context);
      const socketPath = makeSocketPath();
      const ipcListener = createIpcServer(ports);
      const { baseUrl } = await startHttpServer(ports);

      await listenIpcServer(ipcListener, socketPath);
      try {
        const ipcPayload = await requestIpcErrorPayload(socketPath, expected);
        const httpPayload = await requestHttpErrorPayload(baseUrl, ports.identity.token, expected);

        expect(ipcPayload).toEqual(expected);
        expect(httpPayload).toEqual(expected);
      } finally {
        await closeIpcServer(ipcListener);
      }
    },
  );
});
