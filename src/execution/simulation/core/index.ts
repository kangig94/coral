import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import {
  readBackendInfo,
  removeBackendInfoIfOwner,
  writeBackendInfo,
  type BackendInfo,
} from '../../../infra/backend-info.js';
import { ProviderRegistry } from '../../../providers/registry.js';
import type { PreflightRuntime, Provider } from '../../../providers/types.js';
import { readAppendedLines } from '../../../shared/file-tail.js';
import type { CallerContext } from '../../../shared/request-context.js';
import type { ProviderResult } from '../../../shared/types.js';
import type { ProviderName, TerminalOutcome } from '../../../shared/coral-fault.js';
import { formatError, nowIsoString } from '../../../shared/utils.js';
import { SimulationRuntime } from '../../../simulation/runtime.js';
import { sendJson } from '../../http-handler.js';
import { LaunchCoordinator } from '../../engine.js';
import { TypedEventBus } from '../../event-bus.js';
import { createProviderHostManager } from '../../host-manager.js';
import { ProgressStore } from '../../progress-store.js';
import type { Runtime, StoragePort } from '../../../runtime/ports.js';
import { createBackendCore, type BackendCoreResult, type CreateServerFn, type FetchFn } from '../../backend-core.js';
import { recoverPersistedDiscuss as defaultRecoverPersistedDiscuss } from '../../discuss/recovery.js';
import { ExecutionService } from '../../service.js';
import type { MockDurableScript, MockSpawnScript } from './mock-process.js';
import { flushMicrotasks } from './virtual-time.js';
import { toError } from './constants.js';

export { createDeferred, type Deferred } from '../../../shared/test-deferred.js';
export {
  InMemoryStorage,
  normalizePathForStorage,
  type InMemoryStorageSnapshot,
  type InMemoryRoots,
} from './memory-storage.js';
export { createMockAppServerSpawnScript, type MockAppServerScript } from './mock-app.js';
export {
  MockChildProcess,
  MockDurableTransport,
  type MockExecSyncScript,
  MockProcessSpawner,
  MockStdin,
  type ChildOutputChunk,
  type MockDurableScript,
  type MockKillAction,
  type MockSpawnScript,
} from './mock-process.js';
export {
  InMemoryObserver,
  InMemoryPaths,
  SealedEnv,
  SequentialIds,
  type InMemoryPathsSnapshot,
} from './runtime-doubles.js';
export { DEFAULT_EPOCH_MS, VirtualTime, VirtualTimerHandle, flushMicrotasks } from './virtual-time.js';
export { SimulationRuntime } from '../../../simulation/runtime.js';
export type { SimulationRuntimeOptions } from '../../../simulation/runtime.js';

export type FakeProviderScenario = {
  name?: string;
  faultProvider?: ProviderName;
  cli?: {
    command?: string;
    args?: string[];
    extraEnv?: Record<string, string>;
  };
  progress?: Array<{ delayMs?: number; message: string }>;
  result?: Omit<Partial<ProviderResult>, 'outcome'> & Pick<ProviderResult, 'outcome'>;
  preflightError?: Error | string;
};

const DEFAULT_PLUGIN_ROOT = '/tmp/sim/plugin';
const DEFAULT_PROJECT_ROOT = '/tmp/sim/project';
const DEFAULT_VERSION = 'sim-version';
const DEFAULT_BUNDLE_HASH = 'sim-bundle';
const DEFAULT_FAKE_PROVIDER = 'fake-provider';
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 4_100;

export type SimulationScenario = {
  epochMs?: number;
  pluginRoot?: string;
  projectRoot?: string;
  listen?: {
    host?: string;
    port?: number;
  };
  env?: Record<string, string>;
  spawn?: MockSpawnScript[];
  durable?: MockDurableScript[];
  fakeProvider?: FakeProviderScenario;
  recoverPersistedDiscuss?: 'default' | 'stub';
};

function readFileIfPresent(storage: Pick<StoragePort, 'existsSync' | 'readFileSync'>, path: string): string {
  return storage.existsSync(path) ? storage.readFileSync(path, 'utf-8') : '';
}

function createMockKbSubsystem() {
  return {
    kb: {
      closeVectorStores: async () => {},
    } as never,
    curateScheduler: {
      start: async () => {},
      schedule: () => {},
      scheduleDeferredCommit: () => {},
      isRunning: () => false,
      stop: async () => {},
    },
  };
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) {
    return null;
  }

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  const normalizedName = name.toLowerCase();
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === normalizedName)?.[1] ?? null;
  }

  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return entry?.[1] ?? null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createSimulationHealthFetch(runtime: SimulationRuntime, pluginRoot: string): FetchFn {
  return async (url, init) => {
    const parsed = new URL(url);
    const info = readBackendInfo(pluginRoot, runtime);
    const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);

    if (!info || parsed.pathname !== '/health' || parsed.hostname !== info.host || port !== info.port) {
      return jsonResponse({ code: 'not_found', message: 'Not found' }, 404);
    }

    if (headerValue(init?.headers, 'X-Coral-Backend-Token') !== info.token) {
      return jsonResponse({ code: 'unauthorized', message: 'Unauthorized' }, 401);
    }

    return jsonResponse(
      {
        status: 'ok',
        version: info.version,
        bundleHash: info.bundleHash,
        flavor: info.flavor,
        namespace: info.namespace,
        instanceId: info.instanceId,
      },
      200,
    );
  };
}

function buildDefaultExecutionOutcome(aborted: boolean, exitCode: number | null | undefined): TerminalOutcome {
  if (aborted) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return { kind: 'provider_exit', code: exitCode };
  }
  return { kind: 'completed' };
}

function buildRecoveredArtifactFailureOutcome(
  scenario: FakeProviderScenario | undefined,
  message: string,
): TerminalOutcome {
  return {
    kind: 'coral_fault',
    fault: {
      kind: 'provider_request_failed',
      provider: scenario?.faultProvider ?? 'claude',
      message,
    },
  };
}

export function createFakeProvider(runtime: SimulationRuntime, scenario: FakeProviderScenario | undefined): Provider {
  const providerName = scenario?.name ?? DEFAULT_FAKE_PROVIDER;
  const preflightError = scenario?.preflightError;
  return {
    name: providerName,
    ...(preflightError
      ? {
          preflight: async (_runtime: PreflightRuntime) => {
            throw toError(preflightError);
          },
        }
      : {}),
    execute: async (request, providerRuntime) => {
      const startedAt = runtime.time.now();

      for (const progress of scenario?.progress ?? []) {
        if ((progress.delayMs ?? 0) > 0) {
          await runtime.time.sleep(progress.delayMs ?? 0);
        }
        providerRuntime.onEvent({
          jobId: request.sessionId,
          message: progress.message,
          ts: nowIsoString(runtime.time),
        });
      }

      const cli = await providerRuntime.runCli({
        command: scenario?.cli?.command ?? providerName,
        args: scenario?.cli?.args ?? [`--${request.action}`],
        prompt: request.prompt,
        cwd: request.cwd,
        extraEnv: {
          ...request.coralEnv,
          ...(scenario?.cli?.extraEnv ?? {}),
        },
      });

      const exitCode = scenario?.result?.exitCode ?? cli.code;
      const outcome = scenario?.result?.outcome ?? buildDefaultExecutionOutcome(cli.aborted, exitCode);
      const result: ProviderResult = {
        ...scenario?.result,
        content: scenario?.result?.content ?? cli.stdout.trimEnd(),
        exitCode,
        durationMs: scenario?.result?.durationMs ?? runtime.time.now() - startedAt,
        outcome,
      };
      return result;
    },
    artifactRecovery: {
      buildRecoveryMeta: () => ({ provider: providerName }),
      finalizeFromArtifacts: async ({ stdoutPath, stderrPath, exitCode, signal }) => {
        const stdout = readFileIfPresent(runtime.storage, stdoutPath).trimEnd();
        const stderr = readFileIfPresent(runtime.storage, stderrPath).trimEnd();
        const recoveredArtifactFailed = scenario?.result?.outcome === undefined && stderr.length > 0;
        const outcome =
          scenario?.result?.outcome ??
          (recoveredArtifactFailed
            ? buildRecoveredArtifactFailureOutcome(scenario, `artifact recovery failed: ${stderr}`)
            : buildDefaultExecutionOutcome(signal !== null, exitCode));
        const result: ProviderResult = {
          ...scenario?.result,
          content: scenario?.result?.content ?? stdout,
          exitCode: scenario?.result?.exitCode ?? exitCode,
          nonResumable: scenario?.result?.nonResumable ?? (recoveredArtifactFailed ? true : undefined),
          outcome,
        };
        return result;
      },
      extractProgress: ({ stdoutPath, fromOffset }) => {
        const { lines, newOffset } = readAppendedLines(stdoutPath, fromOffset, runtime.storage);
        return {
          messages: lines,
          newOffset,
        };
      },
    },
  };
}

export type SimulationHookLog = {
  createServerCalls: Array<(req: IncomingMessage, res: ServerResponse) => void>;
  listenCalls: Array<{ host: string; port: number }>;
  acquireLockCalls: Array<{
    pluginRoot: string;
    instanceId: string;
    version: string;
    bundleHash: string;
    flavor: 'prod' | 'dev';
  }>;
  writeBackendInfoCalls: Array<{ pluginRoot: string; info: BackendInfo }>;
  removeBackendInfoCalls: Array<{ pluginRoot: string; instanceId: string }>;
  removeLockCalls: Array<{ pluginRoot: string; instanceId: string }>;
  createKbSubsystemCalls: Array<{
    pluginRoot: string;
    processPort: Pick<Runtime['process'], 'exec' | 'execSync'>;
    storagePort: Pick<Runtime['storage'], 'writeAtomicSync'>;
    envPort: Pick<Runtime['env'], 'get'>;
  }>;
  recoverPersistedDiscussCalls: number;
};

export type SimulationController = {
  start: BackendCoreResult['lifecycleController']['start'];
  shutdown: BackendCoreResult['lifecycleController']['shutdown'];
  waitForShutdown: BackendCoreResult['lifecycleController']['waitForShutdown'];
  getLifecycle: () => ReturnType<BackendCoreResult['runtimeState']['getLifecycle']>;
};

export type SimulationBackend = {
  backend: SimulationController;
  runtime: SimulationRuntime;
  eventBus: TypedEventBus;
  progressStore: ProgressStore;
  launchCoordinator: LaunchCoordinator;
  providerRegistry: ProviderRegistry;
  pluginRoot: string;
  projectRoot: string;
  namespace: string;
  hooks: SimulationHookLog;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  createCallerContext: (projectRoot?: string, coralEnv?: Record<string, string>) => CallerContext;
  createService: (projectRoot?: string, coralEnv?: Record<string, string>) => ExecutionService;
  service: ExecutionService;
  advance: (ms: number) => Promise<void>;
};

export function createSimulationBackend(scenario: SimulationScenario = {}): SimulationBackend {
  const runtime = new SimulationRuntime({
    epochMs: scenario.epochMs,
    env: scenario.env,
  });
  for (const spawnScript of scenario.spawn ?? []) {
    runtime.spawner.enqueueSpawn(spawnScript);
  }
  for (const durableScript of scenario.durable ?? []) {
    runtime.spawner.enqueueDurable(durableScript);
  }

  const pluginRoot = scenario.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  const projectRoot = scenario.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const namespace = runtime.paths.pluginRootNamespace(pluginRoot);
  const eventBus = new TypedEventBus();
  const progressStore = new ProgressStore(namespace, runtime, eventBus);
  const launchCoordinator = new LaunchCoordinator({ runtime });
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(createFakeProvider(runtime, scenario.fakeProvider));

  runtime.storage.mkdirSync(pluginRoot, { recursive: true });
  runtime.storage.mkdirSync(projectRoot, { recursive: true });

  const providerHostManager = createProviderHostManager({
    runtime,
    spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
  });

  const hooks: SimulationHookLog = {
    createServerCalls: [],
    listenCalls: [],
    acquireLockCalls: [],
    writeBackendInfoCalls: [],
    removeBackendInfoCalls: [],
    removeLockCalls: [],
    createKbSubsystemCalls: [],
    recoverPersistedDiscussCalls: 0,
  };

  const createCallerContext = (root = projectRoot, coralEnv = { ...runtime.env.coralSnapshot() }): CallerContext => ({
    projectRoot: root,
    pluginRoot,
    coralEnv: { ...coralEnv },
  });

  const createServerFn: CreateServerFn = (handler) => {
    hooks.createServerCalls.push(handler);
    return createServer(handler);
  };

  const listenHost = scenario.listen?.host ?? DEFAULT_LISTEN_HOST;
  const listenPort = scenario.listen?.port ?? DEFAULT_LISTEN_PORT;

  const core = createBackendCore({
    runtime,
    pluginRoot,
    backendNamespace: namespace,
    progressStore,
    launchCoordinator,
    eventBus,
    providerRegistry,
    providerHostManager,
    resolveProjectSourceFn: (root) => runtime.paths.projectSource(root),
    bootSnapshot: {
      version: DEFAULT_VERSION,
      bundleHash: DEFAULT_BUNDLE_HASH,
      flavor: 'dev',
      now: () => runtime.time.now(),
      pid: runtime.env.pid(),
      bindHost: listenHost,
      advertiseHost: listenHost,
    },
    createExecutionService: (ctx, deps) => new ExecutionService(ctx, deps),
    createServerFn,
    fetchFn: createSimulationHealthFetch(runtime, pluginRoot),
    listenFn: async () => {
      hooks.listenCalls.push({ host: listenHost, port: listenPort });
      return { host: listenHost, port: listenPort };
    },
    acquireLockFn: async (bootPluginRoot, instanceId, version, bundleHash, flavor) => {
      hooks.acquireLockCalls.push({
        pluginRoot: bootPluginRoot,
        instanceId,
        version,
        bundleHash,
        flavor,
      });
    },
    writeBackendInfoFn: (bootPluginRoot, info) => {
      hooks.writeBackendInfoCalls.push({ pluginRoot: bootPluginRoot, info });
      runtime.storage.mkdirSync(dirname(runtime.paths.backendInfoPath(bootPluginRoot)), { recursive: true });
      writeBackendInfo(bootPluginRoot, info, runtime);
    },
    removeBackendInfoIfOwnerFn: (bootPluginRoot, instanceId) => {
      hooks.removeBackendInfoCalls.push({ pluginRoot: bootPluginRoot, instanceId });
      removeBackendInfoIfOwner(bootPluginRoot, instanceId, runtime);
    },
    removeLockIfOwnerFn: (bootPluginRoot, instanceId) => {
      hooks.removeLockCalls.push({ pluginRoot: bootPluginRoot, instanceId });
    },
    createKbSubsystemFn: async ({ pluginRoot: kbPluginRoot, processPort, storagePort, envPort }) => {
      hooks.createKbSubsystemCalls.push({
        pluginRoot: kbPluginRoot,
        processPort,
        storagePort,
        envPort,
      });
      return createMockKbSubsystem();
    },
    registerBuiltInProvidersFn: () => {},
    recoverPersistedDiscussFn: async (deps) => {
      hooks.recoverPersistedDiscussCalls += 1;
      if (scenario.recoverPersistedDiscuss === 'default') {
        return defaultRecoverPersistedDiscuss(deps);
      }
      return [];
    },
  });

  const backend: SimulationController = {
    start: () => core.lifecycleController.start(),
    shutdown: (reason) => core.lifecycleController.shutdown(reason),
    waitForShutdown: () => core.lifecycleController.waitForShutdown(),
    getLifecycle: () => core.runtimeState.getLifecycle(),
  };

  const createService = (root = projectRoot, coralEnv = { ...runtime.env.coralSnapshot() }): ExecutionService =>
    core.getExecutionService(createCallerContext(root, coralEnv)) as ExecutionService;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await core.handleRequest(req, res);
    } catch (error: unknown) {
      core.identity.log(`Backend request error: ${formatError(error)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { code: 'internal_error', message: 'Internal error' });
        return;
      }
      res.destroy();
    }
  };

  return {
    backend,
    runtime,
    eventBus,
    progressStore,
    launchCoordinator,
    providerRegistry,
    pluginRoot,
    projectRoot,
    namespace,
    hooks,
    handleRequest,
    createCallerContext,
    createService,
    service: createService(projectRoot),
    advance: async (ms: number) => {
      runtime.time.tick(ms);
      await flushMicrotasks();
    },
  };
}
