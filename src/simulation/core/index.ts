import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import {
  readBackendInfo,
  removeBackendInfoIfOwner,
  writeBackendInfo,
  type BackendInfo,
} from '../../infra/backend-discovery.js';
import { ProviderRegistry } from '../../providers/registry.js';
import type {
  JobTerminal,
  PreflightRuntime,
  ProviderSpec,
} from '../../providers/contract.js';
import { readAppendedLines } from '../../infra/file-tail.js';
import type { CallerContext } from '../../transport/request-context.js';
import {
  providerProgressEvent,
  providerTerminalEvent,
  streamProviderEvents,
} from '../../providers/stream.js';
import { providerRequestFailed } from '../../providers/fault.js';
import { formatError } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { SimulationRuntime } from '../runtime.js';
import { sendJson } from '../../transport/http/handler.js';
import { TypedEventBus } from '../../coordinator/control.js';
import { LaunchCoordinator } from '../../coordinator/live/admission.js';
import { createProviderHostManager } from '../../coordinator/live/provider-hosts/pool.js';
import { ProgressStore } from '../../jobs/job-store.js';
import type { Runtime, StoragePort } from '../../runtime/ports.js';
import { createBackendCore } from '../../coordinator/composition/create-backend-core.js';
import type { BackendCoreResult, CreateServerFn, FetchFn } from '../../coordinator/composition/backend-core-types.js';
import { coordinatorPaths } from '../../infra/coordinator-paths.js';
import { discussReconcile } from '../../discuss/reconcile.js';
import { ExecutionService } from '../../coordinator/execution-service.js';
import { jobsReconcile } from '../../jobs/api.js';
import { openBackendStoreDb } from '../../store/db.js';
import { createDefaultUpcasterRegistry } from '../../store/upcasters.js';
import { createProjectionSessionLookup } from '../../store/queries/sessions.js';
import { createFilesystemSessionLookup, mergeSessionLookups } from '../../sessions/lookup.js';
import { workflowRecover } from '../../workflow/api.js';
import type { MockDurableScript, MockSpawnScript } from './mock-process.js';
import { flushMicrotasks } from './virtual-time.js';
import { toError } from './constants.js';

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
export { SimulationRuntime } from '../runtime.js';
export type { SimulationRuntimeOptions } from '../runtime.js';

type SimulationFaultProviderName = 'claude' | 'codex';
type SimulationTerminalOutcome = JobTerminal['outcome'];

export type FakeProviderScenario = {
  name?: string;
  faultProvider?: SimulationFaultProviderName;
  cli?: {
    command?: string;
    args?: string[];
    extraEnv?: Record<string, string>;
  };
  progress?: Array<{ delayMs?: number; message: string }>;
  result?: {
    content?: string;
    conversationRef?: string;
    model?: string;
    durationMs?: number;
    nonResumable?: boolean;
    exitCode?: number | null;
    warnings?: string[];
    usage?: JobTerminal['usage'];
    outcome: SimulationTerminalOutcome;
  };
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
    kb: {} as never,
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

function buildDefaultExecutionOutcome(
  scenario: FakeProviderScenario | undefined,
  aborted: boolean,
  exitCode: number | null | undefined,
): SimulationTerminalOutcome {
  if (aborted) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return {
      kind: 'failed',
      fault: providerRequestFailed({
        provider: scenario?.name ?? DEFAULT_FAKE_PROVIDER,
        message: `Fake provider exited with code ${exitCode}.`,
      }),
    };
  }
  return { kind: 'completed' };
}

function buildRecoveredArtifactFailureOutcome(
  scenario: FakeProviderScenario | undefined,
  message: string,
): SimulationTerminalOutcome {
  return {
    kind: 'failed',
    fault: providerRequestFailed({
      provider: scenario?.name ?? DEFAULT_FAKE_PROVIDER,
      message,
    }),
  };
}

export function createFakeProvider(
  runtime: SimulationRuntime,
  scenario: FakeProviderScenario | undefined,
): ProviderSpec {
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
    run: (
      request: Parameters<ProviderSpec['run']>[0],
      providerRuntime: Parameters<ProviderSpec['run']>[1],
    ) =>
      streamProviderEvents(async (emit) => {
        const startedAt = runtime.time.now();

        for (const progress of scenario?.progress ?? []) {
          if ((progress.delayMs ?? 0) > 0) {
            await runtime.time.sleep(progress.delayMs ?? 0);
          }
          emit(providerProgressEvent(progress.message, nowIsoString(runtime.time)));
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
        const outcome = scenario?.result?.outcome ?? buildDefaultExecutionOutcome(scenario, cli.aborted, exitCode);
        if (scenario?.result?.conversationRef !== undefined || scenario?.result?.nonResumable !== undefined) {
          emit({
            kind: 'continuity',
            conversationRef: scenario.result?.conversationRef ?? null,
            resumable: scenario.result?.nonResumable !== true,
            providerContinuity: null,
          });
        }
        emit(
          providerTerminalEvent({
            ...scenario?.result,
            content: scenario?.result?.content ?? cli.stdout.trimEnd(),
            exitCode,
            durationMs: scenario?.result?.durationMs ?? runtime.time.now() - startedAt,
            outcome,
          }),
        );
      }),
    recovery: {
      buildRecoveryMeta: () => ({ provider: providerName }),
      finalizeFromArtifacts: async ({
        stdoutPath,
        stderrPath,
        exitCode,
        signal,
      }: Parameters<NonNullable<ProviderSpec['recovery']>['finalizeFromArtifacts']>[0]) => {
        const stdout = readFileIfPresent(runtime.storage, stdoutPath).trimEnd();
        const stderr = readFileIfPresent(runtime.storage, stderrPath).trimEnd();
        const recoveredArtifactFailed = scenario?.result?.outcome === undefined && stderr.length > 0;
        const outcome =
          scenario?.result?.outcome ??
          (recoveredArtifactFailed
            ? buildRecoveredArtifactFailureOutcome(scenario, `artifact recovery failed: ${stderr}`)
            : buildDefaultExecutionOutcome(scenario, signal !== null, exitCode));
        return {
          terminal: providerTerminalEvent({
            ...scenario?.result,
            content: scenario?.result?.content ?? stdout,
            exitCode: scenario?.result?.exitCode ?? exitCode,
            outcome,
          }),
          continuity:
            scenario?.result?.conversationRef !== undefined || scenario?.result?.nonResumable !== undefined
              ? {
                  conversationRef: scenario?.result?.conversationRef ?? null,
                  resumable: scenario?.result?.nonResumable !== true,
                }
              : undefined,
        };
      },
      extractProgress: ({
        stdoutPath,
        fromOffset,
      }: Parameters<NonNullable<NonNullable<ProviderSpec['recovery']>['extractProgress']>>[0]) => {
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
  const storeDb = openBackendStoreDb(runtime, 'dev', { path: ':memory:' });
  const progressStore = new ProgressStore(
    namespace,
    runtime,
    createDefaultUpcasterRegistry(),
    {
      eventBus,
      db: storeDb,
    },
  );
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
    createExecutionService: (ctx, deps) =>
      new ExecutionService(ctx, {
        ...deps,
        sessionLookup: createFilesystemSessionLookup(runtime),
      }),
    createServerFn,
    fetchFn: createSimulationHealthFetch(runtime, pluginRoot),
    listenFn: async () => {
      hooks.listenCalls.push({ host: listenHost, port: listenPort });
      return { host: listenHost, port: listenPort };
    },
    listenIpcFn: async () => ({
      socketPath: coordinatorPaths('dev', runtime.env.fullSnapshot(), {
        baseDir: join(runtime.env.homedir(), '.coral'),
      }).socketPath,
    }),
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
        return discussReconcile.runStartup(deps);
      }
      return [];
    },
    runStartupRecoveryFn: async ({
      identity,
      progressStore,
      providerRegistry,
      getExecutionService,
      getRecoveryService,
      knownDiscussSources,
      getDiscussStoreForSource,
      getDiscussContext,
      createCallerContext,
      recoveryCoordinator,
      assertStartupStillActive,
      cleanupStaleJobs,
      recoverPersistedDiscussFn,
    }) => {
      await jobsReconcile.runStartup({
        recoveryCoordinator,
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createCallerContext,
        assertStartupStillActive,
        log: identity.log,
        cleanupStaleJobs,
        sessionLookup: mergeSessionLookups(
          createProjectionSessionLookup(storeDb),
          createFilesystemSessionLookup(runtime),
        ),
      });
      assertStartupStillActive();

      const recoveredDiscussResumes = await recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createCallerContext,
        assertStartupStillActive,
      });
      assertStartupStillActive();

      await workflowRecover.resumeAll({
        db: storeDb,
        progressStore,
        getExecutionService: (ctx) => getExecutionService(ctx) as never,
        createCallerContext,
      });
      assertStartupStillActive();

      return recoveredDiscussResumes;
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
