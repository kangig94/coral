import { errorMessage } from '../../shared/utils.js';
import type { MutableBackendRuntimeState } from '../../execution/backend-contracts.js';
import type { KbCorpusPublishFailure } from '../../kb/contracts.js';

const HEALTH_ERROR_PREFIX = 'Corpus publication queue unhealthy';
const DEFAULT_FAILURE_THRESHOLD = 3;

export interface CurateSchedulerHealthBridge {
  attachRuntimeState(runtimeState: Pick<MutableBackendRuntimeState, 'getKbInitError' | 'setKbInitError'>): void;
  onCorpusPublishFailure(failure: KbCorpusPublishFailure): void;
  onCorpusPublishSuccess(): void;
}

export function createCurateSchedulerHealthBridge(
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
): CurateSchedulerHealthBridge {
  let runtimeState: Pick<MutableBackendRuntimeState, 'getKbInitError' | 'setKbInitError'> | null = null;

  return {
    attachRuntimeState(nextRuntimeState) {
      runtimeState = nextRuntimeState;
    },
    onCorpusPublishFailure(failure) {
      if (runtimeState === null || failure.consecutiveFailures < failureThreshold) {
        return;
      }

      runtimeState.setKbInitError(
        `${HEALTH_ERROR_PREFIX} after ${failure.consecutiveFailures} consecutive ${failure.stage} failures: ${errorMessage(failure.error)}`,
      );
    },
    onCorpusPublishSuccess() {
      if (runtimeState?.getKbInitError()?.startsWith(HEALTH_ERROR_PREFIX)) {
        runtimeState.setKbInitError(null);
      }
    },
  };
}
