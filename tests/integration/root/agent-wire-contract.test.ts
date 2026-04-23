import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BackendClient, BackendToolHttpError } from '#src/transport/http/client.js';
import * as AgentResolution from '#src/jobs/shell/agent-resolution.js';
import type { MutableRuntimeState } from '#src/coordinator/control.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { HttpHandlerPorts } from '#src/transport/http/contracts.js';
import { createHttpHandler } from '#src/transport/http/handler.js';
import { createProviderHostManager } from '#src/coordinator/live/provider-hosts/pool.js';
import { ProgressStore } from '#src/jobs/job-store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { pluginRootNamespace } from '#src/infra/paths.js';
import { createFilesystemSessionLookup } from '#src/sessions/lookup.js';
import { createPluginRegistry } from '#src/infra/plugin-registry.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import type { ProviderInstruction, ProviderRequest } from '#src/providers/contract.js';
import { toProviderSpec, type Provider } from '#tests/helpers/scripted-provider.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import * as ProviderRequestPolicy from '#src/providers/request-policy.js';
import * as ToolInputSchemas from '#src/transport/http/tool-input.js';
import { streamProviderTerminal } from '#src/providers/stream.js';
import type { LifecycleState } from '#src/coordinator/control.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';

function assertNotMocked(name: string, value: unknown): void {
  if (vi.isMockFunction(value)) {
    throw new Error(`CANONICAL REGRESSION INVARIANT VIOLATED: ${name} is mocked`);
  }
}

beforeAll(() => {
  for (const [name, value] of Object.entries(AgentResolution)) {
    assertNotMocked(`AgentResolution.${name}`, value);
  }
  for (const [name, value] of Object.entries(ProviderRequestPolicy)) {
    assertNotMocked(`ProviderRequestPolicy.${name}`, value);
  }
  for (const [name, value] of Object.entries(ToolInputSchemas)) {
    assertNotMocked(`ToolInputSchemas.${name}`, value);
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

function createRuntimeState(): MutableRuntimeState {
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
  deps: HttpHandlerPorts,
): Promise<{ server: Server; host: string; port: number; token: string }> {
  const handler = createHttpHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ code: 'internal_error', message: error instanceof Error ? error.message : String(error) }),
        );
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
const providerExecute = vi.fn((request: ProviderRequest) => {
  launchRequests.push(cloneProviderRequest(request));
  return streamProviderTerminal({ content: 'stub-provider-result', outcome: { kind: 'completed' as const } });
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
    providerRegistry.register(toProviderSpec(fakeProvider)!);

    const runtime = createRealRuntime();
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const eventBus = new TypedEventBus();
    const progressStore = new ProgressStore('test-ns', runtime, createDefaultUpcasterRegistry(), { eventBus });
    const pluginRegistry = createPluginRegistry({
      storage: runtime.storage,
      env: runtime.env,
      registryPath,
      homeDir: tmpHome,
    });
    const providerHostManager = createProviderHostManager({
      runtime,
      spawnProviderServer: async () => {
        throw new Error('Provider host manager should not be used in agent wire-contract integration test');
      },
    });
    const runtimeState = createRuntimeState();
    const idleTimer = createIdleTimer();
    const services = new Map<string, ExecutionService>();

    const getExecutionService = (ctx: InvocationContext): ExecutionService => {
      const existing = services.get(ctx.projectRoot);
      if (existing) {
        return existing;
      }

      const created = new ExecutionService(ctx, {
        runtime,
        progressStore,
        bundleHash: 'agent-wire-contract-bundle',
        backendNamespace: pluginRootNamespace(coralPluginRoot),
        providerHostManager,
        launchCoordinator,
        eventBus,
        providerRegistry,
        pluginRegistry,
        sessionLookup: createFilesystemSessionLookup(runtime),
      });
      services.set(ctx.projectRoot, created);
      return created;
    };

    const deps: HttpHandlerPorts = {
      identity: {
        pluginRoot: coralPluginRoot,
        namespace: pluginRootNamespace(coralPluginRoot),
        version: '0.0.0-test',
        bundleHash: 'agent-wire-contract-bundle',
        flavor: 'prod',
        instanceId: 'agent-wire-contract-instance',
        token: 'agent-wire-contract-token',
        now: () => Date.now(),
        log: () => {},
      },
      coralEnvSnapshot: {},
      admin: {
        isLifecycleRunning: () => runtimeState.getLifecycle() === 'running',
        isDrainRequested: () => false,
        isLaunchFenceActive: () => runtimeState.getLaunchFenceActive(),
        beginRequest: () => {
          idleTimer.beginRequest();
        },
        endRequest: () => {
          idleTimer.endRequest();
        },
        requestDrain: () => {},
      },
      equipment: {
        registerEquipment: vi.fn(),
        unregisterEquipment: vi.fn(),
        listEquipment: vi.fn(async () => ({ equipment: [] })),
      },
      health: {
        read: () => ({
          status: 'ok',
          version: '0.0.0-test',
          bundleHash: 'agent-wire-contract-bundle',
          flavor: 'prod',
          namespace: pluginRootNamespace(coralPluginRoot),
          instanceId: 'agent-wire-contract-instance',
          uptimeMs: Date.now() - runtimeState.getStartedAt(),
          active: launchCoordinator.active,
          activeJobs: 0,
          liveDiscuss: 0,
          queueDepth: launchCoordinator.queueDepth(),
          inflightRequests: idleTimer.inflightRequests,
          env: {},
          subsystems: {
            kb: 'unavailable',
            discuss: 'ok',
          },
        }),
      },
      events: {
        bus: eventBus,
        addResponse: () => {},
        removeResponse: () => {},
        createStreamId: () => 'stream-id',
        nowIsoString: () => new Date().toISOString(),
        subscribe: () => {},
        unsubscribe: () => {},
      },
      sessions: {
        start: (providerName, input, ctx) => getExecutionService(ctx).start(providerName, input, ctx),
        resumeBySessionId: (input, ctx) => getExecutionService(ctx).resumeBySessionId(input, ctx),
        forkBySessionId: (input, ctx) => getExecutionService(ctx).forkBySessionId(input, ctx),
      },
      jobs: {
        scopeCheck: () => ({ valid: [], missing: [], mismatch: [] }),
        abort: () => ({ aborted: [], notFound: [] }),
        waitStream: async function* () {},
        list: () => [],
        detail: () => null,
      },
      workflows: {
        execute: async () => ({ kind: 'invalid_request', message: 'not implemented' }),
      },
      kb: {
        readSearch: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        readNote: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        readSource: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        readCommunity: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        readMemo: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        readPrinciple: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        listSources: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        listMemos: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        listPrinciples: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        createNote: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        updateNote: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        deleteNote: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        createSource: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        deleteSource: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        createMemo: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        deleteMemos: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        diagnose: () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
        reindex: async () => ({ ok: false, code: 'kb_unavailable', message: 'Knowledge base is not available.' }),
      },
      discuss: {
        seed: () => ({ ok: false, code: 'invalid_request', message: 'not implemented' }),
        start: async () => ({ ok: false, code: 'invalid_request', message: 'not implemented' }),
        listSessions: () => [],
        loadDetail: () => null,
        watch: () => ({ ok: false, code: 'invalid_request', message: 'not implemented' }),
        bid: async () => ({ ok: false, code: 'invalid_request', message: 'not implemented' }),
        speech: async () => ({ ok: false, code: 'invalid_request', message: 'not implemented' }),
        abort: async () => ({ ok: false, code: 'invalid_request', message: 'not implemented' }),
      },
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
  ])(
    'accepts $agent through the real client -> http -> service path',
    async ({ agent, expectedName, expectedInstruction }) => {
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
    },
  );

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
