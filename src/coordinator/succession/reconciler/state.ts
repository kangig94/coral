import type { TimerHandle } from '../../../infra/port-types.js';
import type { SuccessionLaunchSettlement } from './index.js';

export type SuccessionReconcilerState = {
  disposed: boolean;
  launchedAttempt: string | null;
  owedClear: Extract<SuccessionLaunchSettlement, { kind: 'clear-owed' }> | null;
  pendingAttempt: Readonly<{ requestId: string; revision: number; attemptId: string }> | null;
  preparingAttempts: Map<string, number>;
  backoffWake: TimerHandle | null;
};

export function createSuccessionReconcilerState(): SuccessionReconcilerState {
  return {
    disposed: false,
    launchedAttempt: null,
    owedClear: null,
    pendingAttempt: null,
    preparingAttempts: new Map<string, number>(),
    backoffWake: null,
  };
}
