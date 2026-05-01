import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { KbCorpusPublishFailure } from '../../kb/contract.js';
import type { CurateHandle } from '../../kb/curate/scheduler.js';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import type { MutableRuntimeState } from '../lifecycle.js';

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_CURATE_INTERVAL_MS = 60_000;

export interface CurateSchedulerHealthBridge {
  attachRuntimeState(runtimeState: Pick<MutableRuntimeState, 'getCurateHealth' | 'setCurateHealth'>): void;
  onCorpusPublishFailure(failure: KbCorpusPublishFailure): void;
  onCorpusPublishSuccess(): void;
}

export function createCurateSchedulerHealthBridge(
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
): CurateSchedulerHealthBridge {
  let runtimeState: Pick<MutableRuntimeState, 'getCurateHealth' | 'setCurateHealth'> | null = null;

  return {
    attachRuntimeState(nextRuntimeState) {
      runtimeState = nextRuntimeState;
    },
    onCorpusPublishFailure(failure) {
      if (runtimeState === null || failure.consecutivePublishFailureCount < failureThreshold) {
        return;
      }

      runtimeState.setCurateHealth({
        kind: 'degraded',
        reason: `Corpus publication queue unhealthy after ${failure.consecutivePublishFailureCount} consecutive ${failure.stage} failures: ${errorMessage(failure.error)}`,
      });
    },
    onCorpusPublishSuccess() {
      if (runtimeState?.getCurateHealth().kind === 'degraded') {
        runtimeState.setCurateHealth({ kind: 'ok' });
      }
    },
  };
}

function resolveCurateIntervalMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_CURATE_INTERVAL_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CURATE_INTERVAL_MS;
}

function isoUtcDay(now: number): string {
  return nowIsoString(now).slice(0, 10);
}

export function createCoordinatorCurateScheduler(options: {
  scheduler: CurateHandle;
  db: Pick<Database, 'prepare'>;
  runtime: Pick<Runtime, 'env' | 'time'>;
  intervalMs?: number;
}): CurateHandle {
  const intervalMs = options.intervalMs ?? resolveCurateIntervalMs(options.runtime.env.get('CORAL_CURATE_INTERVAL_MS'));
  let timer: ReturnType<Runtime['time']['setInterval']> | null = null;
  let started = false;
  let stopped = false;

  const recordRun = options.db.prepare('UPDATE kb_curate_scheduler SET last_run_day = ? WHERE id = 1');

  const tick = (): void => {
    try {
      recordRun.run(isoUtcDay(options.runtime.time.now()));
      options.scheduler.schedule();
    } catch (error: unknown) {
      backendLog.warn(`Coordinator curate tick failed: ${errorMessage(error)}`);
    }
  };

  const armTimer = (): void => {
    if (timer !== null || stopped) {
      return;
    }

    timer = options.runtime.time.setInterval(tick, intervalMs);
    timer.unref?.();
  };

  return {
    async start() {
      if (started) {
        armTimer();
        return;
      }

      started = true;
      stopped = false;
      await options.scheduler.start();
      armTimer();
    },
    schedule() {
      options.scheduler.schedule();
    },
    scheduleDeferredCommit() {
      options.scheduler.scheduleDeferredCommit();
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        options.runtime.time.clearInterval(timer);
        timer = null;
      }
      await options.scheduler.stop();
    },
    isRunning() {
      return options.scheduler.isRunning();
    },
  };
}
