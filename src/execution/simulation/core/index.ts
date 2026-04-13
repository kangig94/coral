import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { removeBackendInfoIfOwner, writeBackendInfo, type BackendInfo } from '../../../infra/backend-info.js';
import { createPluginRegistry } from '../../../infra/plugin-registry.js';
import { ProviderRegistry } from '../../../providers/registry.js';
import type { Provider } from '../../../providers/types.js';
import { readAppendedLines } from '../../../shared/file-tail.js';
import type { CallerContext } from '../../../shared/request-context.js';
import type { ProviderResult } from '../../../shared/types.js';
import { nowIsoString } from '../../../shared/utils.js';
import { LaunchCoordinator } from '../../engine.js';
import { TypedEventBus } from '../../event-bus.js';
import { createProviderHostManager } from '../../host-manager.js';
import { ProgressStore } from '../../progress-store.js';
import type { Runtime, RuntimeProcess, RuntimeStorage } from '../../runtime.js';
import {
  createBackendServer,
  type BackendServerController,
  type CreateServerFn,
} from '../../server.js';
import { ExecutionService } from '../../service.js';
import { InMemoryStorage, normalizePathForStorage, type InMemoryRoots } from './memory-storage.js';
import {
  MockProcessSpawner,
  type ChildOutputChunk,
  type MockDurableScript,
  type MockKillAction,
  type MockSpawnScript,
} from './mock-process.js';
import { InMemoryPaths, SealedEnv, SequentialIds } from './runtime-doubles.js';
import { DEFAULT_EPOCH_MS, VirtualTime, flushMicrotasks } from './virtual-time.js';

export { createDeferred, type Deferred } from './deferred.js';
export { InMemoryStorage, normalizePathForStorage, type InMemoryStorageSnapshot, type InMemoryRoots } from './memory-storage.js';
export {
  MockChildProcess,
  MockDurableTransport,
  MockProcessSpawner,
  MockStdin,
  type ChildOutputChunk,
  type MockDurableScript,
  type MockKillAction,
  type MockSpawnScript,
} from './mock-process.js';
export { InMemoryPaths, SealedEnv, SequentialIds, type InMemoryPathsSnapshot } from './runtime-doubles.js';
export { DEFAULT_EPOCH_MS, VirtualTime, VirtualTimerHandle, flushMicrotasks } from './virtual-time.js';

export type FakeProviderScenario = {
  name?: string;
  cli?: {
    command?: string;
    args?: string[];
    extraEnv?: Record<string, string>;
  };
  progress?: Array<{ delayMs?: number; message: string }>;
  result?: Partial<ProviderResult>;
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
};

export type SimulationRuntimeOptions = {
  epochMs?: number;
  env?: Record<string, string>;
};

export class SimulationRuntime implements Runtime {
  readonly time: VirtualTime;
  readonly storage: InMemoryStorage;
  readonly paths: InMemoryPaths;
  readonly ids: SequentialIds;
  readonly env: SealedEnv;
  readonly spawner: MockProcessSpawner;
  readonly process: RuntimeProcess;

  constructor(options: SimulationRuntimeOptions = {}) {
    const roots: InMemoryRoots = {};
    this.time = new VirtualTime(options.epochMs ?? DEFAULT_EPOCH_MS);
    this.env = new SealedEnv(options.env);
    this.paths = new InMemoryPaths(roots);
    this.storage = new InMemoryStorage(this.time, roots);
    this.ids = new SequentialIds();
    this.spawner = new MockProcessSpawner(this.time, this.storage);
    this.process = {
      spawn: (spawnOptions) => this.spawner.spawn(spawnOptions),
      kill: (pid, signal) => {
        this.spawner.kill(pid, signal);
      },
      isAlive: (pid) => this.spawner.isAlive(pid),
      durable: this.spawner.durable,
    };
  }
}

function readFileIfPresent(storage: Pick<RuntimeStorage, 'existsSync' | 'readFileSync'>, path: string): string {
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

function toError(value: Error | string): Error {
  return value instanceof Error ? value : new Error(value);
}

export function createFakeProvider(runtime: SimulationRuntime, scenario: FakeProviderScenario | undefined): Provider {
  const providerName = scenario?.name ?? DEFAULT_FAKE_PROVIDER;
  const preflightError = scenario?.preflightError;
  return {
    name: providerName,
    ...(preflightError
      ? {
          preflight: async () => {
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

      const result: ProviderResult = {
        content: scenario?.result?.content ?? cli.stdout.trimEnd(),
        exitCode: scenario?.result?.exitCode ?? cli.code,
        aborted: scenario?.result?.aborted ?? cli.aborted,
        durationMs: scenario?.result?.durationMs ?? runtime.time.now() - startedAt,
        ...scenario?.result,
      };
      return result;
    },
    recovery: {
      buildRecoveryMeta: () => ({ provider: providerName }),
      finalizeFromArtifacts: async ({ stdoutPath, stderrPath, exitCode, signal }) => {
        const stdout = readFileIfPresent(runtime.storage, stdoutPath).trimEnd();
        const stderr = readFileIfPresent(runtime.storage, stderrPath).trimEnd();
        const result: ProviderResult = {
          content: scenario?.result?.content ?? stdout,
          exitCode: scenario?.result?.exitCode ?? exitCode,
          aborted: scenario?.result?.aborted ?? (signal !== null),
          notice: scenario?.result?.notice ?? (stderr.length > 0 ? stderr : undefined),
          ...scenario?.result,
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
  createKbSubsystemCalls: Array<{ pluginRoot: string }>;
  recoverPersistedDiscussCalls: number;
};

export type SimulationBackend = {
  backend: BackendServerController;
  runtime: SimulationRuntime;
  time: VirtualTime;
  storage: InMemoryStorage;
  paths: InMemoryPaths;
  spawner: MockProcessSpawner;
  ids: SequentialIds;
  env: SealedEnv;
  eventBus: TypedEventBus;
  progressStore: ProgressStore;
  launchCoordinator: LaunchCoordinator;
  providerRegistry: ProviderRegistry;
  pluginRoot: string;
  projectRoot: string;
  namespace: string;
  hooks: SimulationHookLog;
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
  const progressStore = new ProgressStore(namespace, eventBus, runtime);
  const launchCoordinator = new LaunchCoordinator({ runtime });
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(createFakeProvider(runtime, scenario.fakeProvider));

  runtime.storage.mkdirSync(pluginRoot, { recursive: true });
  runtime.storage.mkdirSync(projectRoot, { recursive: true });

  const providerHostManager = createProviderHostManager({
    runtime,
    spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
  });
  const pluginRegistry = createPluginRegistry({
    storage: runtime.storage,
    env: runtime.env,
    homeDir: runtime.env.get('HOME'),
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

  const services = new Map<string, ExecutionService>();
  const createCallerContext = (root = projectRoot, coralEnv = { ...runtime.env.coralSnapshot() }): CallerContext => ({
    projectRoot: root,
    pluginRoot,
    coralEnv: { ...coralEnv },
  });

  const createService = (root = projectRoot, coralEnv = { ...runtime.env.coralSnapshot() }): ExecutionService => {
    const key = normalizePathForStorage(root);
    const existing = services.get(key);
    if (existing) {
      return existing;
    }
    const service = new ExecutionService(createCallerContext(root, coralEnv), {
      runtime,
      progressStore,
      bundleHash: DEFAULT_BUNDLE_HASH,
      backendNamespace: namespace,
      providerHostManager,
      launchCoordinator,
      eventBus,
      providerRegistry,
      pluginRegistry,
    });
    services.set(key, service);
    return service;
  };

  const createServerFn: CreateServerFn = (handler) => {
    hooks.createServerCalls.push(handler);
    return createServer(handler);
  };

  const listenHost = scenario.listen?.host ?? DEFAULT_LISTEN_HOST;
  const listenPort = scenario.listen?.port ?? DEFAULT_LISTEN_PORT;

  const backend = createBackendServer({
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
    createExecutionService: (ctx) => createService(ctx.projectRoot, ctx.coralEnv),
    createServerFn,
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
    createKbSubsystemFn: async ({ pluginRoot: kbPluginRoot }) => {
      hooks.createKbSubsystemCalls.push({ pluginRoot: kbPluginRoot });
      return createMockKbSubsystem();
    },
    registerBuiltInProvidersFn: () => {},
    recoverPersistedDiscussFn: async () => {
      hooks.recoverPersistedDiscussCalls += 1;
      return [];
    },
  });

  return {
    backend,
    runtime,
    time: runtime.time,
    storage: runtime.storage,
    paths: runtime.paths,
    spawner: runtime.spawner,
    ids: runtime.ids,
    env: runtime.env,
    eventBus,
    progressStore,
    launchCoordinator,
    providerRegistry,
    pluginRoot,
    projectRoot,
    namespace,
    hooks,
    createCallerContext,
    createService,
    service: createService(projectRoot),
    advance: async (ms: number) => {
      runtime.time.tick(ms);
      await flushMicrotasks();
    },
  };
}
