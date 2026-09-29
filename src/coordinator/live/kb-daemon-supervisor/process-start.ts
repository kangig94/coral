import type { Runtime } from '../../../runtime/ports.js';
import type { KbDaemonSupervisorState } from './state.js';
import { join } from 'node:path';
import { formatError } from '../../../infra/error-format.js';
import type { resolveStrictBundleIdentity } from '../../../infra/bundle-manifest.js';
import { validatedRetainedBuildRoot } from '../../../infra/retained-build-root.js';
import { requirePipedHandles } from '../../../infra/process-supervision.js';
import { encodeResolvedStoreEpoch } from '../../../store/epoch.js';
import type {
  DaemonProcessLike,
  KbDaemonHealthSnapshot,
  KbDaemonProtocolBindings,
  KbDaemonWireTypes,
} from './index.js';
import type { createKbDaemonHealth } from './health.js';
import type { createKbDaemonRequests } from './requests.js';
import type { createKbDaemonParentRequests } from './parent-requests.js';
import { awaitKbDaemonReady } from './process-ready.js';

export function prepareKbDaemonStart(runtime: Runtime, state: KbDaemonSupervisorState): void {
  state.generation += 1;
  state.phase = 'starting';
  state.startedAt = runtime.time.now();
  state.readyAt = null;
  state.lastError = undefined;
  state.lastSetupError = undefined;
  state.stderrBuffer = '';
  // A fresh process repeating what the previous one said is news, not a repeat.
  state.lastStderrLine = null;
  state.repeatedStderrLines = 0;
  state.lastHeartbeatAt = undefined;
  state.lastHeartbeatLatencyMs = undefined;
  state.daemonUptimeMs = undefined;
  state.kbReadHealth = undefined;
  state.kbWriteHealth = undefined;
}

type SpawnConfig = Readonly<{
  runtime: Runtime;
  pluginRoot: string;
  command: string;
  entrypoint: string;
  runningIdentity: ReturnType<typeof resolveStrictBundleIdentity>;
  forwardedKbDaemonEnv: Record<string, string>;
  backendNamespace: string;
  bundleHash: string;
  instanceId: string | undefined;
}>;

type SpawnDependencies = Readonly<{
  setFailure: (message: string) => void;
  rejectPendingRequests: (message: string, activeGeneration?: number) => void;
  abortActiveParentRequests: (reason: string, activeGeneration?: number) => void;
  notifyExitListeners: () => void;
  killFailedSpawn: (child: DaemonProcessLike) => void;
}>;

export function spawnKbDaemonForStart(
  config: SpawnConfig,
  state: KbDaemonSupervisorState,
  dependencies: SpawnDependencies,
): { spawned: DaemonProcessLike; pipedHandles: ReturnType<typeof requirePipedHandles> } | null {
  const {
    runtime,
    pluginRoot,
    command,
    entrypoint,
    runningIdentity,
    forwardedKbDaemonEnv,
    backendNamespace,
    bundleHash,
    instanceId,
  } = config;
  const { setFailure, rejectPendingRequests, abortActiveParentRequests, notifyExitListeners, killFailedSpawn } =
    dependencies;
  let spawned: DaemonProcessLike | null = null;
  let pipedHandles: ReturnType<typeof requirePipedHandles> | undefined;
  try {
    const root =
      (runningIdentity.ok ? validatedRetainedBuildRoot(runtime, runningIdentity.manifest.buildSetId) : null) ??
      pluginRoot;
    spawned = runtime.process.spawn({
      command,
      args: [root === pluginRoot ? entrypoint : join(root, 'bridge', 'coral-backend.cjs')],
      cwd: root,
      envAdditions: {
        // Daemon-identity vars below override any collision.
        ...forwardedKbDaemonEnv,
        CORAL_KB_DAEMON: '1',
        CORAL_KB_DAEMON_GENERATION: String(state.generation),
        CORAL_KB_DAEMON_PARENT_PID: String(process.pid),
        CORAL_KB_DAEMON_BACKEND_NAMESPACE: backendNamespace,
        CORAL_KB_DAEMON_BUNDLE_HASH: bundleHash,
        ...(state.openedStore === undefined
          ? {}
          : { CORAL_KB_DAEMON_STORE: encodeResolvedStoreEpoch(runtime, state.openedStore) }),
        ...(instanceId === undefined ? {} : { CORAL_KB_DAEMON_INSTANCE_ID: instanceId }),
      },
    });
    pipedHandles = requirePipedHandles(spawned, command);
  } catch (error: unknown) {
    if (spawned !== null) {
      const failedSpawn = spawned;
      const startedAtForExit = state.startedAt;
      state.daemonProcess = failedSpawn;
      state.pid = failedSpawn.pid ?? null;
      failedSpawn.on('error', (spawnError) => {
        if (state.daemonProcess === failedSpawn) setFailure(`daemon process error: ${formatError(spawnError)}`);
      });
      failedSpawn.on('close', (code, signal) => {
        state.lastExit = {
          code,
          signal,
          at: runtime.time.now(),
          uptimeMs: startedAtForExit === null ? null : Math.max(0, runtime.time.now() - startedAtForExit),
        };
        if (state.daemonProcess === failedSpawn) {
          state.daemonProcess = null;
          state.pid = null;
          state.readyAt = null;
          rejectPendingRequests('KB daemon exited', state.generation);
          abortActiveParentRequests('KB daemon exited', state.generation);
          if (state.phase === 'stopping') state.phase = 'stopped';
          notifyExitListeners();
        }
      });
      setFailure(`spawn failed: ${formatError(error)}`);
      killFailedSpawn(spawned);
      return null;
    }
    state.daemonProcess = null;
    state.pid = null;
    setFailure(`spawn failed: ${formatError(error)}`);
    return null;
  }
  if (spawned === null || pipedHandles === undefined) {
    setFailure('spawn did not return a daemon process');
    return null;
  }

  return { spawned, pipedHandles };
}

type StartConfig = SpawnConfig &
  Readonly<{
    startTimeoutMs: number;
    onEvent: ((message: KbDaemonWireTypes['eventMessage']) => void) | undefined;
    log: (message: string) => void;
    daemonExitDiagnostic: (stderr: string) => string;
  }>;

type StartDependencies = Pick<
  ReturnType<typeof createKbDaemonHealth>,
  'read' | 'setFailure' | 'notifyExitListeners' | 'forwardDaemonStderrLine'
> &
  Pick<ReturnType<typeof createKbDaemonRequests>, 'rejectPendingRequests'> &
  Pick<ReturnType<typeof createKbDaemonParentRequests>, 'abortActiveParentRequests' | 'handleParentRequest'> &
  Readonly<{
    acceptKbDaemonKill: (child: DaemonProcessLike) => void;
    killFailedSpawn: (child: DaemonProcessLike) => void;
  }>;

export function createKbDaemonStarter(
  config: StartConfig,
  state: KbDaemonSupervisorState,
  dependencies: StartDependencies,
  protocol: KbDaemonProtocolBindings,
) {
  const {
    runtime,
    pluginRoot,
    command,
    entrypoint,
    runningIdentity,
    forwardedKbDaemonEnv,
    backendNamespace,
    bundleHash,
    instanceId,
    startTimeoutMs,
    onEvent,
    log,
    daemonExitDiagnostic,
  } = config;
  const {
    read,
    setFailure,
    acceptKbDaemonKill,
    rejectPendingRequests,
    abortActiveParentRequests,
    notifyExitListeners,
    handleParentRequest,
    forwardDaemonStderrLine,
    killFailedSpawn,
  } = dependencies;
  const startNow = async (): Promise<KbDaemonHealthSnapshot> => {
    if (state.disposed || state.daemonProcess !== null) {
      return read();
    }

    prepareKbDaemonStart(runtime, state);

    const spawn = spawnKbDaemonForStart(
      {
        runtime,
        pluginRoot,
        command,
        entrypoint,
        runningIdentity,
        forwardedKbDaemonEnv,
        backendNamespace,
        bundleHash,
        instanceId: instanceId,
      },
      state,
      {
        setFailure,
        rejectPendingRequests,
        abortActiveParentRequests,
        notifyExitListeners,
        killFailedSpawn: killFailedSpawn,
      },
    );
    if (spawn === null) return read();
    const { spawned, pipedHandles } = spawn;

    const result = await awaitKbDaemonReady(
      runtime,
      state,
      spawned,
      pipedHandles,
      {
        startTimeoutMs,
        onEvent: onEvent,
        log,
        handleParentRequest,
        forwardDaemonStderrLine,
        rejectPendingRequests,
        abortActiveParentRequests,
        notifyExitListeners,
        daemonExitDiagnostic,
      },
      protocol,
    );
    if (result === 'error' && state.daemonProcess === spawned) {
      setFailure(state.lastError ?? 'daemon start failed');
    }
    if (result === 'timeout' && state.daemonProcess === spawned) {
      setFailure(`daemon did not become ready within ${startTimeoutMs}ms`);
      acceptKbDaemonKill(spawned);
    }

    return read();
  };

  return { startNow };
}
