import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { KB_DISABLED_REASON } from '../../infra/kb-toggle.js';
import type { TimePort } from '../../infra/port-types.js';
import type { CreateKbSubsystemOptions, KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import { createKbSubsystem as buildKbRuntime } from '../../kb/subsystem.js';
import type { CurateSchedulerHealthBridge } from '../live/curate-scheduler.js';
import type { Subsystem, SubsystemStatus } from './contract.js';
import { KB_ID, SubsystemUnavailableError } from './contract.js';

/**
 * Deps for the KB subsystem. `buildKbRuntime` runs once outside the retry
 * loop — re-running it per attempt would create a fresh capability registry
 * and silently bypass `capability_name_occupied` guards. `prepareRuntime`
 * also runs exactly once outside the loop (capability catalog init,
 * coordinator curate-scheduler wrap).
 *
 * The retry loop covers only `runBootSequence` — the seven coordinator-side
 * boot steps (promote-recovery, retryPendingCorpusPublication, freshness
 * rebuild, expansion recoverOnBoot, projection-artifact lag repair,
 * notifyCorpus, waitFresh, curateScheduler.start) that touch on-disk state
 * and can fail transiently.
 */
export type CreateKbSubsystemDeps = CreateKbSubsystemOptions & {
  time: Pick<TimePort, 'sleep'>;
  curateBridge: CurateSchedulerHealthBridge;
  prepareRuntime?: (runtime: KnowledgeBaseRuntime) => void;
  runBootSequence: (runtime: KnowledgeBaseRuntime, signal: AbortSignal) => Promise<void>;
  /**
   * Optional override of the runtime build step. Test seam: hosts that need
   * to inject a pre-built `KnowledgeBaseRuntime` (e.g. with mocked
   * `corpusProjectionReader`) supply this; the default uses
   * `buildKbRuntime`. Build still runs once outside the retry loop.
   */
  build?: (options: CreateKbSubsystemOptions) => Promise<KnowledgeBaseRuntime>;
};

/**
 * KB subsystem used when `CORAL_KB_ENABLED=0`. It registers like any subsystem
 * so `/health` and KB-routed handlers behave uniformly, but it never builds a
 * runtime, never runs a boot sequence, and reports a terminal `offline` status
 * with a `disabled` reason. The coordinator wires this instead of the real
 * factory at startup; flipping the env back to enabled requires a daemon
 * restart (the CLI triggers that automatically — see the ensure reconcile).
 */
export function disabledKbSubsystem(): Subsystem<KnowledgeBaseRuntime> {
  const status: SubsystemStatus = { id: KB_ID, phase: 'offline', reason: KB_DISABLED_REASON };
  return {
    id: KB_ID,
    get status() {
      return status;
    },
    resource: () => {
      throw new SubsystemUnavailableError(KB_ID, 'offline');
    },
    onStatusChange: () => () => {},
    init: async () => {},
    dispose: async () => {},
  };
}

const RETRY_BACKOFFS_MS = [1_000, 4_000, 16_000] as const;
const MAX_ATTEMPTS = RETRY_BACKOFFS_MS.length + 1;

export function createKbSubsystem(deps: CreateKbSubsystemDeps): Subsystem<KnowledgeBaseRuntime> {
  let status: SubsystemStatus = { id: KB_ID, phase: 'initializing', attempt: 0 };
  let runtime: KnowledgeBaseRuntime | null = null;
  let unsubscribeCurateBridge: (() => void) | null = null;
  const listeners = new Set<(s: SubsystemStatus) => void>();

  const transition = (next: SubsystemStatus): void => {
    status = next;
    for (const l of listeners) l(next);
  };

  return {
    id: KB_ID,
    get status() {
      return status;
    },
    resource(): KnowledgeBaseRuntime {
      if (status.phase === 'online' || status.phase === 'degraded') {
        if (runtime === null) {
          throw new Error('KB subsystem internal: runtime null in online/degraded phase');
        }
        return runtime;
      }
      throw new SubsystemUnavailableError(KB_ID, status.phase);
    },
    onStatusChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async init(signal) {
      // Build + capability catalog init run outside the retry loop. Both
      // would corrupt state if replayed: a second build creates a fresh
      // capability registry; a second catalog init throws
      // `capability_name_occupied`.
      const buildFn = deps.build ?? buildKbRuntime;
      const built = await buildFn({
        db: deps.db,
        paths: deps.paths,
        curateAssistant: deps.curateAssistant,
        processPort: deps.processPort,
        storagePort: deps.storagePort,
        envPort: deps.envPort,
        timePort: deps.timePort,
        idsPort: deps.idsPort,
        ...(deps.persistCorpusState === undefined ? {} : { persistCorpusState: deps.persistCorpusState }),
        ...(deps.notifyCorpusMutation === undefined ? {} : { notifyCorpusMutation: deps.notifyCorpusMutation }),
        ...(deps.onCorpusPublishFailure === undefined ? {} : { onCorpusPublishFailure: deps.onCorpusPublishFailure }),
        ...(deps.onCorpusPublishSuccess === undefined ? {} : { onCorpusPublishSuccess: deps.onCorpusPublishSuccess }),
      });
      runtime = built;
      deps.prepareRuntime?.(built);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal.aborted) {
          transition({ id: KB_ID, phase: 'offline', reason: 'shutdown' });
          return;
        }
        transition({ id: KB_ID, phase: 'initializing', attempt });
        try {
          await deps.runBootSequence(built, signal);
          unsubscribeCurateBridge = attachCurateBridge(deps.curateBridge, transition);
          transition({ id: KB_ID, phase: 'online' });
          return;
        } catch (error) {
          if (signal.aborted) {
            transition({ id: KB_ID, phase: 'offline', reason: 'shutdown' });
            return;
          }
          backendLog.warn(`[subsystem:kb] init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${errorMessage(error)}`);
          if (attempt === MAX_ATTEMPTS) {
            const lastLogLine = backendLog.lastLineFor('subsystem:kb');
            transition({
              id: KB_ID,
              phase: 'offline',
              reason: errorMessage(error),
              ...(lastLogLine === undefined ? {} : { lastLogLine }),
            });
            backendLog.error('[subsystem:kb] init exhausted retries — offline until restart', error);
            return;
          }
          const backoffMs = RETRY_BACKOFFS_MS[attempt - 1] ?? 0;
          backendLog.info(`[subsystem:kb] retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
          try {
            await deps.time.sleep(backoffMs, { signal });
          } catch {
            transition({ id: KB_ID, phase: 'offline', reason: 'shutdown' });
            return;
          }
        }
      }
    },
    async dispose(_signal) {
      unsubscribeCurateBridge?.();
      unsubscribeCurateBridge = null;
      if (runtime !== null) {
        try {
          await runtime.curateScheduler.stop();
        } catch (error) {
          backendLog.warn(`[subsystem:kb] dispose: curate scheduler stop failed: ${errorMessage(error)}`);
        }
      }
      runtime = null;
      transition({ id: KB_ID, phase: 'offline', reason: 'disposed' });
    },
  };
}

/**
 * Wires the curate-publish health bridge to the KB subsystem's `transition`
 * callback. The bridge owns the consecutive-failure counter; this attach
 * step decides which `SubsystemStatus` shape to emit (online vs degraded).
 * Returns the unsubscribe used by `dispose()`.
 */
function attachCurateBridge(
  bridge: CurateSchedulerHealthBridge,
  transition: (next: SubsystemStatus) => void,
): () => void {
  bridge.attach((reason) => {
    if (reason === null) {
      transition({ id: KB_ID, phase: 'online' });
      return;
    }
    transition({ id: KB_ID, phase: 'degraded', reason });
  });
  return bridge.detach.bind(bridge);
}
