import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  readBackendInfo,
  removeBackendInfoIfOwner,
  writeBackendInfo,
  type BackendInfo,
} from '../../../src/infra/backend-discovery.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { none } from '../../../src/providers/capability.js';
import type { ProviderTerminal, PreflightRuntime, ProviderSpec } from '../../../src/providers/contract.js';
import { defineProvider, type ProviderDefinition } from '../../../src/providers/registry.js';
import { readAppendedLines } from '../../../src/infra/file-tail.js';
import type { InvocationContext } from '../../../src/runtime/invocation-context.js';
import type { ProviderCredentialSet } from '../../../src/infra/provider-credential-sources.js';
import type { Principal } from '../../../src/security/principal.js';
import { providerProgressEvent, providerTerminalEvent, streamProviderEvents } from '../../../src/providers/stream.js';
import { providerRequestFailed } from '../../../src/providers/fault.js';
import { formatError } from '../../../src/infra/error-format.js';
import { nowIsoString } from '../../../src/infra/time.js';
import { SimulationRuntime } from '../runtime.js';
import { sendJson } from '../../../src/transport/http/handler.js';
import { TypedEventBus } from '../../../src/coordinator/event-bus.js';
import { LaunchCoordinator } from '../../../src/coordinator/live/admission.js';
import { createProviderHostManager } from '../../../src/coordinator/live/provider-hosts/index.js';
import { JobStore } from '../../../src/jobs/store.js';
import { loadJobProjectionDetails } from '../../../src/jobs/read-queries.js';
import { noProviderLookupPort } from '../../../src/providers/catalog.js';
import { jobsRegistry } from '../../../src/jobs/events.js';
import { sessionsRegistry } from '../../../src/sessions/events.js';
import { discussRegistry as discussStoreRegistry } from '../../../src/discuss/event-registry.js';
import { workflowRegistry } from '../../../src/workflow/events.js';
import type { StoragePort } from '../../../src/infra/port-types.js';
import { createCoordinatorCore } from '../../../src/coordinator/composition/index.js';
import type { CoordinatorCoreResult, CreateServerFn, FetchFn } from '../../../src/coordinator/composition/types.js';
import type { CoordinatorStoreServices } from '../../../src/coordinator/composition/store-services-ref.js';
import type { KbDaemonHealthSnapshot, KbDaemonSupervisor } from '../../../src/coordinator/live/kb-daemon-supervisor.js';
import { coordinatorPaths } from '../../../src/infra/path/coordinator.js';
import * as discussRecovery from '../../../src/discuss/shell/recovery.js';
import { ExecutionService } from '../../../src/coordinator/execution-service.js';
import { createWorkflowRecoveryFinalizer } from '../../../src/coordinator/services/workflow-recovery-finalizer.js';
import { jobsReconcile } from '../../../src/jobs/startup.js';
import { openWritableStoreDbNoReset } from '../../../src/store/db.js';
import { createEventBodyCodec } from '../../../src/store/event-body-codec.js';
import { composeReducers } from '../../../src/store/reducers.js';
import { createProjectionSessionLookup } from '../../../src/sessions/lookup.js';
import { workflowRecover } from '../../../src/workflow/recover.js';
import { setStoreServicesForTest } from '../../testing/store-services.js';
import type { MockDurableScript, MockSpawnScript } from './mock-script-types.js';
import { flushMicrotasks } from './virtual-time.js';
import { toError } from './constants.js';
import { z } from 'zod';
import type { ProviderBindingCodec } from '../../../src/providers/contracts/binding.js';

type SimulationFaultProviderName = 'claude' | 'codex';
type SimulationTerminalOutcome = ProviderTerminal['outcome'];

const simulationSelectionSchema = z.object({ key: z.string() }).strict();
const simulationProfileSchema = z.object({ canonicalLocation: z.string(), routing: z.object({}).strict() }).strict();
const simulationBindingSchema = z
  .object({ profile: simulationProfileSchema, guarantee: z.literal('profile-only') })
  .strict();

function simulationBindingCodec(
  provider: string,
): ProviderBindingCodec<z.infer<typeof simulationSelectionSchema>, z.infer<typeof simulationProfileSchema>> {
  return {
    selectionSchema: simulationSelectionSchema,
    profileSchema: simulationProfileSchema,
    bindingSchema: simulationBindingSchema,
    bindingKind: 'profile',
    selectorLabel: () => `${provider} simulation selector`,
    presentBinding: () => `${provider} simulation profile`,
  };
}

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
    usage?: ProviderTerminal['usage'];
    outcome: SimulationTerminalOutcome;
  };
  preflightError?: Error | string;
};

const DEFAULT_PLUGIN_ROOT = '/tmp/sim/plugin';
const DEFAULT_PROJECT_ROOT = '/tmp/sim/project';
const DEFAULT_VERSION = 'sim-version';
const DEFAULT_BUNDLE_HASH = 'sim-bundle';
const DEFAULT_FAKE_PROVIDER = 'codex';
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 4_100;
const SIMULATION_PROVIDER_CREDENTIALS = {
  version: 1,
  codex: { version: 1, provider: 'codex', kind: 'home', home: '/tmp/sim/accounts/codex' },
  claude: {
    version: 1,
    provider: 'claude',
    kind: 'config-dir',
    configDir: '/tmp/sim/accounts/claude',
    projectsRoot: '/tmp/sim/accounts/claude/projects',
  },
} as const satisfies ProviderCredentialSet;

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
): ProviderDefinition {
  const providerName = scenario?.name ?? DEFAULT_FAKE_PROVIDER;
  const preflightError = scenario?.preflightError;
  return defineProvider({
    name: providerName,
    ...(preflightError
      ? {
          preflight: async (_runtime: PreflightRuntime) => {
            throw toError(preflightError);
          },
        }
      : {}),
    run: (request: Parameters<ProviderSpec['run']>[0], providerRuntime: Parameters<ProviderSpec['run']>[1]) =>
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
  })
    .binding(simulationBindingCodec(providerName))
    .artifacts(none(`Simulation provider ${providerName} declares no provider artifacts.`))
    .build();
}

export type SimulationHookLog = {
  createServerCalls: Array<(req: IncomingMessage, res: ServerResponse) => void>;
  listenCalls: Array<{ host: string; port: number }>;
  writeBackendInfoCalls: Array<{ pluginRoot: string; info: BackendInfo }>;
  removeBackendInfoCalls: Array<{ pluginRoot: string; instanceId: string }>;
  kbDaemonStartCalls: Array<{ pluginRoot: string }>;
  kbDaemonWarmupCalls: Array<{ pluginRoot: string }>;
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
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'coral-sim-backend-'));
  const runtime = new SimulationRuntime({
    epochMs: scenario.epochMs,
    env: scenario.env,
    roots: { coralRoot: runtimeRoot },
  });
  mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true });
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
  const storeDb = openWritableStoreDbNoReset(runtime, { path: ':memory:' });
  const progressStore = new JobStore(namespace, runtime, createEventBodyCodec(), {
    eventBus,
    db: storeDb,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussStoreRegistry, workflowRegistry),
    providers: noProviderLookupPort,
  });
  const storeServices: CoordinatorStoreServices = {
    storeDb,
    progressStore,
    consumerDriver: null,
  };
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
    writeBackendInfoCalls: [],
    removeBackendInfoCalls: [],
    kbDaemonStartCalls: [],
    kbDaemonWarmupCalls: [],
    recoverPersistedDiscussCalls: 0,
  };

  const createInvocationContext = (
    root = projectRoot,
    coralEnv = { ...runtime.env.coralSnapshot() },
  ): InvocationContext => {
    const principal: Principal = {
      subject: 'operator',
      transport: 'simulation',
      credential: { kind: 'simulation', id: 'operator' },
      binding: { kind: 'project', root },
    };
    return {
      projectRoot: root,
      pluginRoot,
      coralEnv: { ...coralEnv },
      principal,
      providerCredentials: SIMULATION_PROVIDER_CREDENTIALS,
    };
  };

  const createServerFn: CreateServerFn = (handler) => {
    hooks.createServerCalls.push(handler);
    return createServer(handler);
  };

  const listenHost = scenario.listen?.host ?? DEFAULT_LISTEN_HOST;
  const listenPort = scenario.listen?.port ?? DEFAULT_LISTEN_PORT;
  const kbDaemonHealth: KbDaemonHealthSnapshot = {
    enabled: true,
    phase: 'online',
    generation: 1,
    pid: runtime.env.pid(),
    startedAt: runtime.time.now(),
    readyAt: runtime.time.now(),
  };
  const kbDaemonSupervisor: KbDaemonSupervisor = {
    read: () => ({ ...kbDaemonHealth }),
    start: async () => {
      hooks.kbDaemonStartCalls.push({ pluginRoot });
      return { ...kbDaemonHealth };
    },
    probe: async () => ({ ...kbDaemonHealth }),
    warmup: async () => {
      hooks.kbDaemonWarmupCalls.push({ pluginRoot });
      return { ...kbDaemonHealth };
    },
    readKb: async (request) => ({
      ok: true,
      data: { servedBy: 'simulation-kb-daemon', method: request.method },
    }),
    mutateKb: async (request) => ({
      ok: true,
      data: { servedBy: 'simulation-kb-daemon', method: request.method },
    }),
    expansionRpc: async (request) => ({
      ok: true,
      data: { servedBy: 'simulation-kb-daemon', method: request.method },
    }),
    abortKbJobs: async (jobIds) => ({ aborted: [], notFound: [...jobIds] }),
    listActiveKbJobs: async () => ({ active: [] }),
    stop: async () => ({ ...kbDaemonHealth }),
    restart: async () => ({ ...kbDaemonHealth }),
    dispose: async () => undefined,
    onExit: () => () => {},
  };

  const core = createCoordinatorCore({
    runtime,
    pluginRoot,
    backendNamespace: namespace,
    launchCoordinator,
    eventBus,
    providerRegistry,
    providerHostManager,
    getConsumerStuck: () => [],
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
    createStoreServicesFromDbFn: (openedStoreDb) => {
      if (openedStoreDb !== storeDb) {
        openedStoreDb.close();
      }
      return storeServices;
    },
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
    kbDaemonSupervisor,
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
      signal,
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
        signal,
        log: identity.log,
        cleanupStaleJobs,
        sessionLookup: createProjectionSessionLookup(storeDb),
        coordinatorCommit: (cb) => progressStore.commit(cb),
      });
      signal.throwIfAborted();

      const recoveredDiscussResumes = await recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createInvocationContext,
        signal,
      });
      signal.throwIfAborted();

      await workflowRecover.resumeAll({
        db: storeDb,
        progressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: (ctx) => getExecutionService(ctx) as never,
        createInvocationContext,
        finalizeWorkflow: createWorkflowRecoveryFinalizer({
          runtime,
          progressStore,
          coordinatorCommit: (cb) => progressStore.commit(cb),
          log: identity.log,
        }),
        time: runtime.time,
      });
      signal.throwIfAborted();

      return recoveredDiscussResumes;
    },
  });
  setStoreServicesForTest(core.storeServicesRef, storeServices, { storeDbPath: ':memory:' });

  let cleanedRuntimeRoot = false;
  const cleanupRuntimeRoot = (): void => {
    if (cleanedRuntimeRoot) {
      return;
    }
    cleanedRuntimeRoot = true;
    rmSync(runtimeRoot, { recursive: true, force: true });
  };

  const backend: SimulationController = {
    start: () => core.lifecycleController.start(),
    shutdown: async (reason) => {
      try {
        await core.lifecycleController.shutdown(reason);
      } finally {
        cleanupRuntimeRoot();
      }
    },
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
