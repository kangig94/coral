import { formatError } from '../../../infra/error-format.js';
import { retryUpgradeIntentCas, type UpgradeIntent } from '../../../infra/upgrade-intent.js';
import type { SuccessionCommitPorts } from './index.js';
import type { SuccessionLaunchSettlement } from '../reconciler/index.js';

export function createCommitAttemptRecorder(ports: SuccessionCommitPorts) {
  const runDir = ports.runtime.paths.coral.coordinator.runDir;
  const updateAttempt = async (attemptId: string, change: (intent: UpgradeIntent) => UpgradeIntent): Promise<void> => {
    const outcome = await retryUpgradeIntentCas(runDir, (observed) => {
      if (observed.kind !== 'readable' || observed.intent.attemptId !== attemptId) {
        throw new Error('Succession attempt changed while recording its commit window.');
      }
      return {
        kind: 'write',
        expectedRevision: observed.intent.revision,
        change: change(observed.intent),
        settle: () => undefined,
      };
    });
    if (outcome.kind === 'refused') throw new Error(`Succession intent could not be recorded: ${outcome.problem}`);
    if (outcome.kind === 'exhausted') throw new Error('Succession intent changed throughout its commit window.');
  };

  const recordBestEffort = async (
    attemptId: string,
    change: (intent: UpgradeIntent) => UpgradeIntent,
  ): Promise<boolean> => {
    try {
      await updateAttempt(attemptId, change);
      return true;
    } catch (error: unknown) {
      ports.log(`Succession hold recording failed: ${formatError(error)}\n`);
      return false;
    }
  };

  const clearAttempt = async (
    attemptId: string,
    clear: (intent: UpgradeIntent) => UpgradeIntent,
  ): Promise<SuccessionLaunchSettlement> =>
    (await recordBestEffort(attemptId, clear)) ? { kind: 'settled' } : { kind: 'clear-owed', attemptId, clear };

  const recordReleasePending = async (
    attemptId: string,
    status: Pick<UpgradeIntent, 'blockers' | 'retryCondition'>,
  ): Promise<void> => {
    await recordBestEffort(attemptId, (intent) => ({ ...intent, ...status }));
  };

  return { updateAttempt, recordBestEffort, clearAttempt, recordReleasePending };
}
