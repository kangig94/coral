import { formatError } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import { isLivePhase, isTerminalPhase } from '../../jobs/phase.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { JobStore } from '../../jobs/store.js';
import { markJobAsError } from '../../jobs/reconcile/recovery-effects.js';
import { SuccessionWriterParkedError } from '../../store/db.js';
import type { KbDaemonHealthSnapshot, KbDaemonSupervisor } from '../live/kb-daemon-supervisor/index.js';
import { type createCoordinatorWorld } from './world.js';

const KB_DAEMON_JOB_ABORT_PROXY_TTL_MS = 24 * 60 * 60 * 1000;

function createDaemonJobAbortProxyRegistry({
  runtime,
  world,
  kbDaemonSupervisor,
  internalJobAbortRegistry,
}: Pick<
  Parameters<typeof createKbDaemonJobTracking>[0],
  'runtime' | 'world' | 'kbDaemonSupervisor' | 'internalJobAbortRegistry'
>) {
  const state = {
    daemonOwnedKbJobs: new Map<string, { cleanupTimer: ReturnType<typeof runtime.time.setTimeout> }>(),
    daemonJobTerminalListenersRegistered: false,
  };
  const cleanupDaemonJobAbortProxy = (jobId: string): void => {
    const tracked = state.daemonOwnedKbJobs.get(jobId);
    if (tracked !== undefined) {
      runtime.time.clearTimeout(tracked.cleanupTimer);
      state.daemonOwnedKbJobs.delete(jobId);
    }
    internalJobAbortRegistry.remove(jobId);
    if (state.daemonOwnedKbJobs.size === 0) {
      disposeDaemonJobTerminalListeners();
    }
  };
  const cleanupTerminalDaemonJobAbortProxy = (jobId: string, phase: string): void => {
    if (!isTerminalPhase(phase) || !state.daemonOwnedKbJobs.has(jobId)) {
      return;
    }
    cleanupDaemonJobAbortProxy(jobId);
  };
  const onDaemonJobPhaseChanged = (event: { jobId: string; phase: string }): void => {
    cleanupTerminalDaemonJobAbortProxy(event.jobId, event.phase);
  };
  const onDaemonJobCompleted = (event: { jobId: string }): void => {
    if (!state.daemonOwnedKbJobs.has(event.jobId)) {
      return;
    }
    cleanupDaemonJobAbortProxy(event.jobId);
  };
  const ensureDaemonJobTerminalListeners = (): void => {
    if (state.daemonJobTerminalListenersRegistered) {
      return;
    }
    state.daemonJobTerminalListenersRegistered = true;
    world.eventBus.on('job:phase_changed', onDaemonJobPhaseChanged);
    world.eventBus.on('job:completed', onDaemonJobCompleted);
  };
  const disposeDaemonJobTerminalListeners = (): void => {
    if (!state.daemonJobTerminalListenersRegistered) {
      return;
    }
    state.daemonJobTerminalListenersRegistered = false;
    world.eventBus.off('job:phase_changed', onDaemonJobPhaseChanged);
    world.eventBus.off('job:completed', onDaemonJobCompleted);
  };
  const registerDaemonJobAbortProxy = (jobId: string): void => {
    cleanupDaemonJobAbortProxy(jobId);
    ensureDaemonJobTerminalListeners();
    const cleanupTimer = runtime.time.setTimeout(() => {
      cleanupDaemonJobAbortProxy(jobId);
    }, KB_DAEMON_JOB_ABORT_PROXY_TTL_MS);
    cleanupTimer.unref?.();
    state.daemonOwnedKbJobs.set(jobId, { cleanupTimer });
    internalJobAbortRegistry.register(jobId, () => {
      const tracked = state.daemonOwnedKbJobs.get(jobId);
      if (tracked !== undefined) {
        runtime.time.clearTimeout(tracked.cleanupTimer);
      }
      const abortResult =
        kbDaemonSupervisor.abortKbJobs?.([jobId]) ?? Promise.resolve({ aborted: [], notFound: [jobId] });
      void abortResult.finally(() => {
        cleanupDaemonJobAbortProxy(jobId);
      });
    });
  };
  return { state, cleanupDaemonJobAbortProxy, disposeDaemonJobTerminalListeners, registerDaemonJobAbortProxy };
}

function attachDaemonJobExitSettlement(
  {
    runtime,
    world,
    kbDaemonSupervisor,
    getProgressStore,
  }: Pick<
    Parameters<typeof createKbDaemonJobTracking>[0],
    'runtime' | 'world' | 'kbDaemonSupervisor' | 'getProgressStore'
  >,
  proxies: ReturnType<typeof createDaemonJobAbortProxyRegistry>,
): () => void {
  const { cleanupDaemonJobAbortProxy } = proxies;
  const daemonOwnedKbJobs = proxies.state.daemonOwnedKbJobs;
  let disposed = false;
  const describeKbDaemonExit = (snapshot: KbDaemonHealthSnapshot): string => {
    const exit = snapshot.lastExit;
    const suffix =
      exit === undefined
        ? ''
        : ` (code=${String(exit.code)}, signal=${String(exit.signal)}, generation=${snapshot.generation})`;
    return `KB daemon exited${suffix}: ${snapshot.lastError ?? snapshot.reason ?? snapshot.phase}`;
  };
  const listDurableDaemonOwnedKbJobs = (progressStore: JobProgressStore): string[] => {
    const jobIds: string[] = [];
    for (const jobId of progressStore.listJobIds()) {
      const status = progressStore.readStatus(jobId);
      if (status === null || !isLivePhase(status.phase) || status.jobKind !== 'kb') {
        continue;
      }
      const runtime = progressStore.readRuntimeProjection(jobId);
      if (runtime?.transport === 'internal' && runtime.owner === 'kb-daemon') {
        jobIds.push(jobId);
      }
    }
    return jobIds;
  };
  const failTrackedDaemonJobs = (snapshot: KbDaemonHealthSnapshot): void => {
    const message = describeKbDaemonExit(snapshot);
    try {
      const progressStore = getProgressStore();
      const daemonOwnedJobIds = new Set([...daemonOwnedKbJobs.keys(), ...listDurableDaemonOwnedKbJobs(progressStore)]);
      if (daemonOwnedJobIds.size === 0) {
        return;
      }
      const failed: string[] = [];
      for (const jobId of daemonOwnedJobIds) {
        const status = progressStore.readStatus(jobId);
        if (status === null || !isLivePhase(status.phase) || status.jobKind !== 'kb') {
          cleanupDaemonJobAbortProxy(jobId);
          continue;
        }
        markJobAsError(
          progressStore,
          status,
          { kind: 'wrapper_crashed', cause: { message } },
          runtime.time.now(),
          (line) => world.log(`${line}\n`),
        );
        cleanupDaemonJobAbortProxy(jobId);
        failed.push(jobId);
      }
      if (failed.length > 0) {
        world.log(`[kb-daemon] marked ${failed.length} daemon-owned KB job(s) as error after daemon exit\n`);
      }
    } catch (error: unknown) {
      if (error instanceof SuccessionWriterParkedError) {
        void error.unparked.then(() => {
          if (!disposed) failTrackedDaemonJobs(snapshot);
        });
        return;
      }
      world.log(`[kb-daemon] failed to reconcile daemon-owned KB jobs after daemon exit: ${formatError(error)}\n`);
    }
  };
  const unsubscribe = kbDaemonSupervisor.onExit?.(failTrackedDaemonJobs);
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}

export function createKbDaemonJobTracking({
  runtime,
  world,
  kbDaemonSupervisor,
  getProgressStore,
  internalJobAbortRegistry,
}: {
  runtime: Runtime;
  world: ReturnType<typeof createCoordinatorWorld>;
  kbDaemonSupervisor: KbDaemonSupervisor;
  getProgressStore: () => JobStore;
  internalJobAbortRegistry: ReturnType<
    ReturnType<typeof createCoordinatorWorld>['launchCoordinator']['getInternalAbortRegistry']
  >;
}): {
  kbDaemonSupervisorWithTrackedShutdown: KbDaemonSupervisor;
  disposeKbDaemonExitListener: () => void;
  disposeDaemonJobTerminalListeners: () => void;
  registerDaemonJobAbortProxy: (jobId: string) => void;
} {
  const proxies = createDaemonJobAbortProxyRegistry({ runtime, world, kbDaemonSupervisor, internalJobAbortRegistry });
  const { registerDaemonJobAbortProxy, disposeDaemonJobTerminalListeners } = proxies;
  const trackActiveDaemonKbJobs = async (reason: string, signal?: AbortSignal): Promise<void> => {
    try {
      const activeJobs = (await kbDaemonSupervisor.listActiveKbJobs?.({ signal }))?.active ?? [];
      for (const jobId of activeJobs) {
        registerDaemonJobAbortProxy(jobId);
      }
      if (activeJobs.length > 0) {
        world.log(`[kb-daemon] tracking ${activeJobs.length} active KB job(s) before ${reason}\n`);
      }
    } catch (error: unknown) {
      world.log(`[kb-daemon] failed to list active KB jobs before ${reason}: ${formatError(error)}\n`);
    }
  };
  const kbDaemonSupervisorWithTrackedShutdown: KbDaemonSupervisor = {
    ...kbDaemonSupervisor,
    restart: async (reason, signal) => {
      await trackActiveDaemonKbJobs(reason ?? 'restart', signal);
      signal?.throwIfAborted();
      return kbDaemonSupervisor.restart(reason, signal);
    },
    dispose: async (reason, disposeOptions) => {
      await trackActiveDaemonKbJobs(reason ?? 'dispose', disposeOptions?.signal);
      return kbDaemonSupervisor.dispose(reason, disposeOptions);
    },
  };
  const disposeKbDaemonExitListener = attachDaemonJobExitSettlement(
    { runtime, world, kbDaemonSupervisor, getProgressStore },
    proxies,
  );
  return {
    kbDaemonSupervisorWithTrackedShutdown,
    disposeKbDaemonExitListener,
    disposeDaemonJobTerminalListeners,
    registerDaemonJobAbortProxy,
  };
}
