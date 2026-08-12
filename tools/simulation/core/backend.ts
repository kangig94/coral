import { describeCoralStoreFormat } from '#src/store-format.js';
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
import type {
  ProviderRecoveryContract,
  ProviderStandalone,
  ProviderTerminal,
} from '../../../src/providers/contract.js';
import { defineProvider, type ProviderDefinition } from '../../../src/providers/registry.js';
import {
  allExecutionLifetimes,
  compileEnvironmentLayers,
  CORAL_PROCESS_ENV_KEYS,
  CORAL_TURN_ENV_KEYS,
  environmentLayer,
  EXECUTION_ENV_ALLOWLIST,
  filterEnvironmentValues,
  type EnvironmentLayer,
  type ProviderExecutionPlan,
} from '../../../src/providers/execution-plan.js';
import { readAppendedLines } from '../../../src/infra/file-tail.js';
import type { InvocationContext } from '../../../src/runtime/invocation-context.js';
import type { CanonicalWorkDir } from '../../../src/runtime/canonical-work-dir.js';
import type { ProviderScope } from '../../../src/infra/provider-scope.js';
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
import { createHostAdmissionCollection } from '../../../src/providers/host-admission.js';
import { JobStore } from '../../../src/jobs/store.js';
import { loadJobProjectionDetails } from '../../../src/jobs/read-queries.js';
import { providerLookupPortFromCatalog } from '../../../src/providers/catalog.js';
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
import { createFailedWorkflowDescendantReleaser } from '../../../src/coordinator/services/workflow-recovery-descendants.js';
import { openStoreDatabase } from '../../../src/store/db.js';
import { createEventBodyCodec } from '../../../src/store/event-body-codec.js';
import { composeReducers } from '../../../src/store/reducers.js';
import { workflowRecover } from '../../../src/workflow/recover.js';
import { setStoreServicesForTest } from '../../testing/store-services.js';
import type { MockDurableScript, MockSpawnScript } from './mock-script-types.js';
import { flushMicrotasks } from './virtual-time.js';
import { toError } from './constants.js';
import { z } from 'zod';
import {
  bindingFailure,
  bindingSuccess,
  type AccountSubject,
  type ProviderBindingCodec,
} from '../../../src/providers/contracts/binding.js';
import type { JsonValue } from '../../../src/infra/json-value.js';
import { zodPersistedParser, zodValueParser } from '../../../src/providers/binding-parser.js';

type SimulationFaultProviderName = 'claude' | 'codex';
type SimulationTerminalOutcome = ProviderTerminal['outcome'];

function createSimulationSelectionSchema() {
  return z.object({ key: z.string() }).strict();
}

function createSimulationProfileSchema() {
  return z
    .object({
      canonicalLocation: z.string(),
      routing: z.union([
        z.object({ kind: z.literal('home') }).strict(),
        z.object({ kind: z.literal('config-dir'), emitConfigDir: z.literal(true) }).strict(),
      ]),
    })
    .strict();
}

function createSimulationBindingSchema() {
  return z.object({ profile: createSimulationProfileSchema(), guarantee: z.literal('profile-only') }).strict();
}

type SimulationSelection = z.infer<ReturnType<typeof createSimulationSelectionSchema>>;
type SimulationProfile = z.infer<ReturnType<typeof createSimulationProfileSchema>>;

type SimulationProviderAccess = {
  readonly profileRoot: string;
  readonly routingEnv: Readonly<Record<string, string>>;
};

type SimulationExecutionPlan = ProviderExecutionPlan<
  Readonly<{ access: SimulationProviderAccess; platform: string; environment: readonly EnvironmentLayer[] }>,
  Readonly<{ sessionId: string }>,
  Readonly<{ environment: readonly EnvironmentLayer[] }>
>;

type SimulationBindingCodec = Extract<
  ProviderBindingCodec<SimulationSelection, SimulationProfile, AccountSubject & JsonValue, SimulationProviderAccess>,
  { readonly bindingKind: 'profile' }
>;

function simulationBindingCodec(provider: string): SimulationBindingCodec {
  return {
    parseSelection: zodValueParser(createSimulationSelectionSchema),
    persistedProfile: zodPersistedParser(createSimulationProfileSchema),
    persistedContinuity: zodPersistedParser(() => z.record(z.string(), z.unknown())),
    persistedBinding: zodPersistedParser(createSimulationBindingSchema),
    bindingKind: 'profile',
    captureSelection: () => bindingSuccess({ key: provider }),
    async canonicalizeProfile(selection) {
      return bindingSuccess({
        canonicalLocation: `/${selection.key}`,
        routing:
          provider === 'claude'
            ? { kind: 'config-dir' as const, emitConfigDir: true as const }
            : { kind: 'home' as const },
      });
    },
    selectorLabel: () => `${provider} simulation selector`,
    renderFailure: (failure) => `${provider} simulation binding failed: ${failure.reason}`,
    async bindProfile(profile) {
      return bindingSuccess({ profile, guarantee: 'profile-only' });
    },
    async readiness(_binding, use) {
      return bindingSuccess({ ready: true, use });
    },
    access(binding) {
      const routingEnv: Record<string, string> =
        provider === 'claude'
          ? { CLAUDE_CONFIG_DIR: binding.profile.canonicalLocation }
          : { CODEX_HOME: binding.profile.canonicalLocation };
      return {
        profileRoot: binding.profile.canonicalLocation,
        routingEnv,
      };
    },
    compareBinding: (left, right) =>
      left.profile.canonicalLocation === right.profile.canonicalLocation
        ? bindingSuccess(true)
        : bindingFailure({ reason: 'profile-mismatch', provider }),
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
const DEFAULT_VERSION = '0.0.0-sim';
const DEFAULT_BUILD_SET_ID = '00000000-0000-4000-8000-000000000000';
const DEFAULT_BUNDLE_HASH = '0000000000000000';
const DEFAULT_FAKE_PROVIDER = 'codex';
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 4_100;
function simulationProviderScope(provider: string): ProviderScope {
  return {
    origin: 'caller',
    profiles: [
      {
        provider,
        profile: {
          canonicalLocation: `/tmp/sim/accounts/${provider}`,
          routing:
            provider === 'claude'
              ? { kind: 'config-dir' as const, emitConfigDir: true as const }
              : { kind: 'home' as const },
        },
      },
    ],
  };
}

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
  const run: ProviderStandalone<SimulationExecutionPlan> = (request, providerRuntime) =>
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
    });
  return defineProvider<SimulationExecutionPlan, SimulationProviderAccess>({
    name: providerName,
    transport: 'standalone',
    run,
    prepareExecutionPlan: ({ access, request, baseEnv, protectedEnv, platform }) => {
      const authority = { CORAL_CHILD: '1', CORAL_SESSION_ID: request.sessionId, ...(protectedEnv ?? {}) };
      const hostEnvironment = [
        environmentLayer(
          {
            name: 'simulation-base',
            lifetime: 'host',
            provenance: 'simulation-runtime',
            values: filterEnvironmentValues(baseEnv, EXECUTION_ENV_ALLOWLIST, platform),
            writes: EXECUTION_ENV_ALLOWLIST,
            protects: new Set(),
          },
          platform,
        ),
        environmentLayer(
          {
            name: 'simulation-routing',
            lifetime: 'host',
            provenance: 'simulation-binding',
            values: access.routingEnv,
            writes: new Set(Object.keys(access.routingEnv)),
            protects: new Set(Object.keys(access.routingEnv)),
          },
          platform,
        ),
        environmentLayer(
          {
            name: 'simulation-process-settings',
            lifetime: 'host',
            provenance: 'simulation-request-process',
            values: filterEnvironmentValues(
              request.coralEnv,
              new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]),
              platform,
            ),
            writes: new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]),
            protects: new Set(),
          },
          platform,
        ),
      ];
      const turnEnvironment = [
        environmentLayer(
          {
            name: 'simulation-turn',
            lifetime: 'turn',
            provenance: 'simulation',
            values: filterEnvironmentValues(
              { ...request.coralEnv, ...authority, ...(scenario?.cli?.extraEnv ?? {}) },
              new Set([
                ...CORAL_TURN_ENV_KEYS,
                ...Object.keys(authority),
                ...Object.keys(scenario?.cli?.extraEnv ?? {}),
              ]),
              platform,
            ),
            writes: new Set([
              ...CORAL_TURN_ENV_KEYS,
              ...Object.keys(authority),
              ...Object.keys(scenario?.cli?.extraEnv ?? {}),
            ]),
            protects: new Set(Object.keys(authority)),
          },
          platform,
        ),
      ];
      const plan: SimulationExecutionPlan = Object.freeze({
        host: Object.freeze({ access, platform, environment: Object.freeze(hostEnvironment) }),
        session: Object.freeze({ sessionId: request.sessionId }),
        turn: Object.freeze({ environment: Object.freeze(turnEnvironment) }),
      });
      const exactEnv = compileEnvironmentLayers([...hostEnvironment, ...turnEnvironment], {
        platform,
        lifetimes: allExecutionLifetimes(),
      });
      return {
        plan,
        prepareCliRequest: (cliRequest) => ({ ...cliRequest, exactEnv: { ...exactEnv }, extraEnv: undefined }),
      };
    },
    ...(preflightError
      ? {
          preflight: async () => {
            throw toError(preflightError);
          },
        }
      : {}),
    recovery: {
      finalizeInterrupted: () => {
        throw new Error(`Simulation provider '${providerName}' does not support app-server recovery.`);
      },
      finalizeFromArtifacts: async ({
        stdoutPath,
        stderrPath,
        exitCode,
        signal,
        durationMs,
      }: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0]) => {
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
            durationMs,
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
      }: Parameters<NonNullable<ProviderRecoveryContract['extractProgress']>>[0]) => {
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
  const providerRegistry = new ProviderRegistry();
  const fakeProvider = createFakeProvider(runtime, scenario.fakeProvider);
  providerRegistry.register(fakeProvider);
  const storeFormat = describeCoralStoreFormat(providerRegistry);
  const providerScope = simulationProviderScope(fakeProvider.name);
  const storeDb = openStoreDatabase({
    path: ':memory:',
    storage: runtime.storage,
    storeFormat,
  });
  const progressStore = new JobStore(namespace, runtime, createEventBodyCodec(), {
    eventBus,
    db: storeDb,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussStoreRegistry, workflowRegistry),
    providers: providerLookupPortFromCatalog(providerRegistry),
  });
  const storeServices: CoordinatorStoreServices = {
    storeDb,
    progressStore,
    consumerDriver: null,
  };
  const launchCoordinator = new LaunchCoordinator({ runtime });
  runtime.storage.mkdirSync(pluginRoot, { recursive: true });
  runtime.storage.mkdirSync(projectRoot, { recursive: true });

  const providerHostManager = createProviderHostManager({
    runtime,
    spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
    admission: createHostAdmissionCollection({ classify: () => 'unknown' }),
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
    const canonicalRoot = root as CanonicalWorkDir;
    const principal: Principal = {
      subject: 'operator',
      transport: 'simulation',
      credential: { kind: 'simulation', id: 'operator' },
      binding: { kind: 'project', root: canonicalRoot },
    };
    return {
      projectRoot: canonicalRoot,
      pluginRoot,
      coralEnv: { ...coralEnv },
      principal,
      providerScope,
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

  const core = createCoordinatorCore(
    {
      storeFormat,
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
        buildSetId: DEFAULT_BUILD_SET_ID,
        bundleHash: DEFAULT_BUNDLE_HASH,
        flavor: runtime.flavor,
        now: () => runtime.time.now(),
        pid: runtime.env.pid(),
        bindHost: listenHost,
        advertiseHost: listenHost,
      },
      createExecutionService: (ctx, deps) =>
        new ExecutionService(ctx, {
          ...deps,
          coordinatorCommit: (cb) => progressStore.commit(cb),
        }),
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
    },
    async (
      {
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
        providerOperationStartupOwnership,
        signal,
        recoverPersistedDiscussFn,
      },
      runJobsStartup,
    ) => {
      const recoveryProgressStore = await runJobsStartup({
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        signal,
        log: identity.log,
        coordinatorCommit: (cb) => progressStore.commit(cb),
        providerOperationStartupOwnership,
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
        progressStore: recoveryProgressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: (ctx) => getExecutionService(ctx) as never,
        createInvocationContext,
        finalizeWorkflow: createWorkflowRecoveryFinalizer({
          runtime,
          progressStore,
          coordinatorCommit: (cb) => progressStore.commit(cb),
          log: identity.log,
        }),
        releaseFailedWorkflowDescendants: createFailedWorkflowDescendantReleaser({
          progressStore: recoveryProgressStore,
          runtime,
          coordinatorCommit: (cb) => progressStore.commit(cb),
          getExecutionService,
          createInvocationContext,
          releaseAdoptedJob: recoveryCoordinator.releaseAdoptedJob,
          emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
          log: identity.log,
        }),
        signal,
        time: runtime.time,
      });
      signal.throwIfAborted();

      return recoveredDiscussResumes;
    },
  );
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
