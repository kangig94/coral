import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BackendClient, BackendToolHttpError } from '../../client/http-client.js';
import * as AgentResolution from '../../execution/agent-resolution.js';
import type { HttpHandlerDeps, MutableBackendRuntimeState } from '../../execution/backend-contracts.js';
import { LaunchCoordinator } from '../../execution/engine.js';
import { TypedEventBus } from '../../execution/event-bus.js';
import { createHttpHandler } from '../../execution/http-handler.js';
import { createProviderHostManager } from '../../execution/host-manager.js';
import { ProgressStore } from '../../execution/progress-store.js';
import { ExecutionService } from '../../execution/service.js';
import { SessionIndex } from '../../execution/session-index.js';
import { pluginRootNamespace } from '../../infra/paths.js';
import { createPluginRegistry } from '../../infra/plugin-registry.js';
import { ProviderRegistry } from '../../providers/registry.js';
import type { Provider } from '../../providers/types.js';
import type { CallerContext } from '../../shared/request-context.js';
import * as Schemas from '../../shared/schemas.js';
import type { ProviderInstruction, ProviderRequest } from '../../shared/types.js';
import type { LifecycleState } from '../../execution/server-types.js';

function assertNotMocked(name: string, value: unknown): void {
  if (vi.isMockFunction(value)) {
    throw new Error(`CANONICAL REGRESSION INVARIANT VIOLATED: ${name} is mocked`);
  }
}

beforeAll(() => {
  for (const [name, value] of Object.entries(AgentResolution)) {
    assertNotMocked(`AgentResolution.${name}`, value);
  }
  for (const [name, value] of Object.entries(Schemas)) {
    assertNotMocked(`Schemas.${name}`, value);
  }
  assertNotMocked('BackendClient.prototype.createSession', BackendClient.prototype.createSession);
});

type RecordedLaunchRequest = ProviderRequest & {
  instruction?: ProviderInstruction;
};

function cloneProviderRequest(request: ProviderRequest): RecordedLaunchRequest {
  return {
    ...request,
    coralEnv: { ...request.coralEnv },
    ...(request.instruction ? { instruction: { ...request.instruction } } : {}),
  };
}

function writeFile(rootDir: string, relativePath: string, content: string): string {
  const filePath = join(rootDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function createRuntimeState(): MutableBackendRuntimeState {
  let lifecycle: LifecycleState = 'running';
  let startedAt = Date.now();
  let launchFenceActive = false;

  return {
    getLifecycle: () => lifecycle,
    getStartedAt: () => startedAt,
    getKbSubsystem: () => null,
    getKbInitError: () => null,
    getLaunchFenceActive: () => launchFenceActive,
    setLifecycle: (state) => {
      lifecycle = state;
    },
    setStartedAt: (ts) => {
      startedAt = ts;
    },
    setKbSubsystem: () => {},
    setKbInitError: () => {},
    setLaunchFenceActive: (active) => {
      launchFenceActive = active;
    },
  };
}

function createIdleTimer() {
  let inflightRequests = 0;

  return {
    beginRequest: () => {
      inflightRequests += 1;
    },
    endRequest: () => {
      if (inflightRequests > 0) {
        inflightRequests -= 1;
      }
    },
    startWatching: () => {},
    stopWatching: () => {},
    requestDrain: () => {},
    isDraining: false,
    get inflightRequests() {
      return inflightRequests;
    },
  };
}

async function startHttpHandlerServer(
  deps: HttpHandlerDeps,
): Promise<{ server: Server; host: string; port: number; token: string }> {
  const handler = createHttpHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_error', message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected in-process test server to bind to a TCP port');
  }

  return {
    server,
    host: '127.0.0.1',
    port: address.port,
    token: deps.identity.token,
  };
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server || !server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  });
}

async function waitForLaunchRequest(launchRequests: readonly RecordedLaunchRequest[]): Promise<RecordedLaunchRequest> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const request = launchRequests[0];
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for provider launch request');
}

const launchRequests: RecordedLaunchRequest[] = [];
const providerExecute = vi.fn(async (request: ProviderRequest) => {
  launchRequests.push(cloneProviderRequest(request));
  return { content: 'stub-provider-result' };
});

describe('agent wire contract', () => {
  let tmpRoot = '';
  let tmpHome = '';
  let projectRoot = '';
  let coralPluginRoot = '';
  let registryPath = '';
  let server: Server | null = null;
  let client: BackendClient;
  let previousHome: string | undefined;
  let previousCoralPluginRegistry: string | undefined;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agent-wire-contract-'));
    tmpHome = join(tmpRoot, 'home');
    projectRoot = join(tmpRoot, 'project');
    coralPluginRoot = join(tmpRoot, 'coral-plugin');
    registryPath = join(tmpRoot, 'installed_plugins.json');

    mkdirSync(tmpHome, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(coralPluginRoot, { recursive: true });

    writeFile(projectRoot, '.claude/agents/my-local.md', 'LOCAL AGENT CONTENT');
    writeFile(coralPluginRoot, 'agents/architect.md', 'CORAL AGENT CONTENT');
    writeFile(tmpRoot, 'installed_plugins.json', JSON.stringify({ version: 1, plugins: {} }, null, 2));

    previousHome = process.env.HOME;
    previousCoralPluginRegistry = process.env.CORAL_PLUGIN_REGISTRY;
    process.env.HOME = tmpHome;
    process.env.CORAL_PLUGIN_REGISTRY = registryPath;

    const providerRegistry = new ProviderRegistry();
    const fakeProvider: Provider = {
      name: 'stub',
      execute: providerExecute,
    };
    providerRegistry.register(fakeProvider);

    const launchCoordinator = new LaunchCoordinator();
    const eventBus = new TypedEventBus();
    const progressStore = new ProgressStore(eventBus);
    const sessionIndex = new SessionIndex();
    const pluginRegistry = createPluginRegistry();
    const providerHostManager = createProviderHostManager({
      spawnProviderServer: async () => {
        throw new Error('Provider host manager should not be used in agent wire-contract integration test');
      },
    });
    const runtimeState = createRuntimeState();
    const idleTimer = createIdleTimer();
    const services = new Map<string, ExecutionService>();

    const getExecutionService = (ctx: CallerContext): ExecutionService => {
      const existing = services.get(ctx.projectRoot);
      if (existing) {
        return existing;
      }

      const created = new ExecutionService(ctx, {
        progressStore,
        bundleHash: 'agent-wire-contract-bundle',
        providerHostManager,
        launchCoordinator,
        eventBus,
        providerRegistry,
        pluginRegistry,
      });
      services.set(ctx.projectRoot, created);
      return created;
    };

    const deps: HttpHandlerDeps = {
      identity: {
        pluginRoot: coralPluginRoot,
        namespace: pluginRootNamespace(coralPluginRoot),
        version: '0.0.0-test',
        bundleHash: 'agent-wire-contract-bundle',
        instanceId: 'agent-wire-contract-instance',
        token: 'agent-wire-contract-token',
        now: () => Date.now(),
        log: () => {},
      },
      runtimeState,
      idleTimer: idleTimer as never,
      progressStore,
      sessionIndex,
      activeLaunchCount: () => launchCoordinator.active,
      queueDepth: () => launchCoordinator.queueDepth(),
      streamResponses: new Set(),
      isDrainRequested: () => false,
      requestDrain: () => {},
      getExecutionService,
      getDiscussContext: () => ({}) as never,
      providerRegistry,
      abortJobs: () => ({ aborted: [], notFound: [] }),
      scopeCheckJobs: () => ({ valid: [], missing: [], mismatch: [] }),
      subscribeBackendEvents: () => {},
      unsubscribeBackendEvents: () => {},
      liveDiscussCount: () => 0,
      listDiscussSessions: () => [],
      loadDiscussDetail: () => null,
    };

    const started = await startHttpHandlerServer(deps);
    server = started.server;
    client = new BackendClient({
      ensureBackend: async () => ({
        host: started.host,
        port: started.port,
        token: started.token,
        instanceId: 'agent-wire-contract-instance',
      }),
      defaultContext: {
        projectRoot,
        pluginRoot: coralPluginRoot,
        coralEnv: {},
      },
    });
  });

  beforeEach(() => {
    launchRequests.splice(0, launchRequests.length);
    providerExecute.mockClear();
  });

  afterAll(async () => {
    await closeServer(server);

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousCoralPluginRegistry === undefined) {
      delete process.env.CORAL_PLUGIN_REGISTRY;
    } else {
      process.env.CORAL_PLUGIN_REGISTRY = previousCoralPluginRegistry;
    }

    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { agent: 'architect', expectedName: 'architect', expectedInstruction: 'CORAL AGENT CONTENT' },
    { agent: 'coral:architect', expectedName: 'architect', expectedInstruction: 'CORAL AGENT CONTENT' },
    { agent: 'project:my-local', expectedName: 'my-local', expectedInstruction: 'LOCAL AGENT CONTENT' },
    { agent: 'architect.md', expectedName: 'architect', expectedInstruction: 'CORAL AGENT CONTENT' },
  ])('accepts $agent through the real client -> http -> service path', async ({ agent, expectedName, expectedInstruction }) => {
    const response = await client.createSession('stub', 'hello from integration', { agent });

    expect(response).toEqual({
      session: expect.any(String),
      job: expect.any(String),
      launchState: 'running',
    });
    expect(providerExecute).toHaveBeenCalledTimes(1);

    const request = await waitForLaunchRequest(launchRequests);
    expect(request.action).toBe('exec');
    expect(request.prompt).toBe('hello from integration');
    expect(request.name).toBe(expectedName);
    expect(request.instruction).toEqual({
      channel: 'system',
      content: expectedInstruction,
    });
  });

  it('rejects INVALID! with HTTP 400 at the schema boundary', async () => {
    let caught: unknown;

    try {
      await client.createSession('stub', 'hello from integration', { agent: 'INVALID!' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackendToolHttpError);
    expect((caught as BackendToolHttpError).statusCode).toBe(400);
    expect((caught as BackendToolHttpError).body).toEqual(
      expect.objectContaining({
        code: 'invalid_request',
      }),
    );
    expect(providerExecute).not.toHaveBeenCalled();
    expect(launchRequests).toEqual([]);
  });
});
