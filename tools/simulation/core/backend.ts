import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import {
  readBackendInfo,
  removeBackendInfoIfOwner,
  writeBackendInfo,
  type BackendInfo,
} from '../../../src/infra/backend-discovery.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import type {
  JobTerminal,
  PreflightRuntime,
  ProviderSpec,
} from '../../../src/providers/contract.js';
import { readAppendedLines } from '../../../src/infra/file-tail.js';
import type { InvocationContext } from '../../../src/runtime/invocation-context.js';
import {
  providerProgressEvent,
  providerTerminalEvent,
  streamProviderEvents,
} from '../../../src/providers/stream.js';
import { providerRequestFailed } from '../../../src/providers/fault.js';
import { formatError } from '../../../src/infra/error-format.js';
import { nowIsoString } from '../../../src/infra/time.js';
import { SimulationRuntime } from '../runtime.js';
import { sendJson } from '../../../src/transport/http/handler.js';
import { TypedEventBus } from '../../../src/coordinator/event-bus.js';
import { LaunchCoordinator } from '../../../src/coordinator/live/admission.js';
import { createProviderHostManager } from '../../../src/coordinator/live/provider-hosts/index.js';
import { JobStore } from '../../../src/jobs/store.js';
import { jobsRegistry } from '../../../src/jobs/events.js';
import { sessionsRegistry } from '../../../src/sessions/events.js';
import { discussRegistry as discussStoreRegistry } from '../../../src/discuss/event-registry.js';
import { workflowRegistry } from '../../../src/workflow/events.js';
import type { Runtime, StoragePort } from '../../../src/runtime/ports.js';
import { createCoordinatorCore } from '../../../src/coordinator/composition/index.js';
import type { CoordinatorCoreResult, CreateServerFn, FetchFn } from '../../../src/coordinator/composition/types.js';
import { coordinatorPaths } from '../../../src/infra/path/coordinator.js';
import * as discussRecovery from '../../../src/discuss/shell/recovery.js';
import { ExecutionService } from '../../../src/coordinator/execution-service.js';
import { createWorkflowRecoveryFinalizer } from '../../../src/coordinator/services/workflow-recovery-finalizer.js';
import { jobsReconcile } from '../../../src/jobs/startup.js';
import { openBackendStoreDb } from '../../../src/store/db.js';
import { createDefaultUpcasterRegistry } from '../../../src/store/upcaster-registry.js';
import { composeReducers } from '../../../src/store/reducers.js';
import { createProjectionSessionLookup } from '../../../src/sessions/lookup.js';
import { asReadonlyDatabase, type ReadonlyDatabase } from '../../../src/kb/read-port.js';
import { workflowRecover } from '../../../src/workflow/recover.js';
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
    resumable?: boolean;
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

function createMockKbSubsystem(readDb: ReadonlyDatabase) {
  return {
    kb: {} as never,
    readDb,
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

function createSimulationHealthFetch(runtime: SimulationRuntime, _pluginRoot: string): FetchFn {
  return async (url, init) => {
    const parsed = new URL(url);
    const info = readBackendInfo({
      storage: runtime.storage,
      env: runtime.env,
      paths: runtime.paths,
    });
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
  _scenario: FakeProviderScenario | undefined,
  aborted: boolean,
  exitCode: number | null | undefined,
): SimulationTerminalOutcome {
  if (aborted) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return { kind: 'failed' };
  }
  return { kind: 'completed' };
}

function buildRecoveredArtifactFailureOutcome(
  _scenario: FakeProviderScenario | undefined,
  _message: string,
): SimulationTerminalOutcome {
  return { kind: 'failed' };
}

function buildSimulationFailureCause(
  scenario: FakeProviderScenario | undefined,
  message: string,
): ReturnType<typeof providerRequestFailed> {
  return providerRequestFailed({
    provider: scenario?.name ?? DEFAULT_FAKE_PROVIDER,
    message,
  });
}

function failureCauseForSimulationOutcome(
  scenario: FakeProviderScenario | undefined,
  outcome: SimulationTerminalOutcome,
  message: string,
): ReturnType<typeof providerRequestFailed> | undefined {
  return outcome.kind === 'failed' ? buildSimulationFailureCause(scenario, message) : undefined;
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
        const failureCause = failureCauseForSimulationOutcome(
          scenario,
          outcome,
          typeof exitCode === 'number' && exitCode !== 0
            ? `Fake provider exited with code ${exitCode}.`
            : 'Fake provider failed.',
        );
        if (scenario?.result?.conversationRef !== undefined || scenario?.result?.resumable !== undefined) {
          emit({
            kind: 'continuity',
            conversationRef: scenario.result?.conversationRef ?? null,
            resumable: scenario.result?.resumable ?? true,
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
            failureCause,
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
        const failureCause = failureCauseForSimulationOutcome(
          scenario,
          outcome,
          recoveredArtifactFailed
            ? `artifact recovery failed: ${stderr}`
            : typeof exitCode === 'number' && exitCode !== 0
              ? `Fake provider exited with code ${exitCode}.`
              : 'Fake provider failed.',
        );
        return {
          terminal: providerTerminalEvent({
            ...scenario?.result,
            content: scenario?.result?.content ?? stdout,
            exitCode: scenario?.result?.exitCode ?? exitCode,
            outcome,
            failureCause,
          }),
          continuity:
            scenario?.result?.conversationRef !== undefined || scenario?.result?.resumable !== undefined
              ? {
                  conversationRef: scenario?.result?.conversationRef ?? null,
                  resumable: scenario?.result?.resumable ?? true,
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
  start: CoordinatorCoreResult['lifecycleController']['start'];
  shutdown: CoordinatorCoreResult['lifecycleController']['shutdown'];
  waitForShutdown: CoordinatorCoreResult['lifecycleController']['waitForShutdown'];
  getLifecycle: () => ReturnType<CoordinatorCoreResult['runtimeState']['getLifecycle']>;
};

export type SimulationBackend = {
  backend: SimulationController;
  runtime: SimulationRuntime;
  eventBus: TypedEventBus;
  progressStore: JobStore;
  launchCoordinator: LaunchCoordinator;
  providerRegistry: ProviderRegistry;
  pluginRoot: string;
  projectRoot: string;
  namespace: string;
  hooks: SimulationHookLog;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  createInvocationContext: (projectRoot?: string, coralEnv?: Record<string, string>) => InvocationContext;
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
  const storeDb = openBackendStoreDb(runtime, { path: ':memory:' });
  const progressStore = new JobStore(
    namespace,
    runtime,
    createDefaultUpcasterRegistry(),
    {
      eventBus,
      db: storeDb,
      reducers: composeReducers(jobsRegistry, sessionsRegistry, discussStoreRegistry, workflowRegistry),
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

  const createInvocationContext = (root = projectRoot, coralEnv = { ...runtime.env.coralSnapshot() }): InvocationContext => ({
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

  const core = createCoordinatorCore({
    runtime,
    pluginRoot,
    backendNamespace: namespace,
    progressStore,
    launchCoordinator,
    eventBus,
    providerRegistry,
    providerHostManager,
    getConsumerStuck: () => [],
    getMutationBlocked: () => ({ blocked: false }),
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
        sessionLookup: createProjectionSessionLookup(storeDb),
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
    writeBackendInfoFn: (info) => {
      hooks.writeBackendInfoCalls.push({ pluginRoot, info });
      runtime.storage.mkdirSync(dirname(runtime.paths.coral.coordinator.infoFile), { recursive: true });
      writeBackendInfo(info, {
        storage: runtime.storage,
        env: runtime.env,
        paths: runtime.paths,
      });
    },
    removeBackendInfoIfOwnerFn: (instanceId) => {
      hooks.removeBackendInfoCalls.push({ pluginRoot, instanceId });
      removeBackendInfoIfOwner(instanceId, {
        storage: runtime.storage,
        env: runtime.env,
        paths: runtime.paths,
      });
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
      return createMockKbSubsystem(asReadonlyDatabase(storeDb));
    },
    registerBuiltInProvidersFn: () => {},
    recoverPersistedDiscussFn: async (deps) => {
      hooks.recoverPersistedDiscussCalls += 1;
      if (scenario.recoverPersistedDiscuss === 'default') {
        return discussRecovery.runStartup(deps);
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
      createInvocationContext,
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
        createInvocationContext,
        assertStartupStillActive,
        log: identity.log,
        cleanupStaleJobs,
        sessionLookup: createProjectionSessionLookup(storeDb),
      });
      assertStartupStillActive();

      const recoveredDiscussResumes = await recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createInvocationContext,
        assertStartupStillActive,
      });
      assertStartupStillActive();

      await workflowRecover.resumeAll({
        db: storeDb,
        progressStore,
        getExecutionService: (ctx) => getExecutionService(ctx) as never,
        createInvocationContext,
        finalizeWorkflow: createWorkflowRecoveryFinalizer({
          runtime,
          progressStore,
          coordinatorCommit: (cb) => progressStore.commit(cb),
          log: identity.log,
        }),
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
    core.getExecutionService(createInvocationContext(root, coralEnv)) as ExecutionService;

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
    createInvocationContext,
    createService,
    service: createService(projectRoot),
    advance: async (ms: number) => {
      runtime.time.tick(ms);
      await flushMicrotasks();
    },
  };
}
