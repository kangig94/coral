import { isAbortError, isUserAbort } from '../../../runtime/abort.js';
import type { CurateAssistantPort } from '../../../kb/curate/assistant.js';
import type { KbRuntime } from '../../../kb/contract.js';
import { runCommunitySummaryAgent } from '../../../kb/curate/community/summary-agent.js';
import type { RunCommunitySummaryJob } from '../../../kb/curate/scheduler.js';
import { type KbJobRecorder, normalizeKbFailureDetail } from './recorder.js';

/**
 * Builds the scheduler's `runCommunitySummaryJob` callback: records one
 * observable, abortable `kb.community_summary` job around a single
 * community-summary agent turn. Returns whether the agent wrote summaries (false
 * when the stale work-list was already empty — no token spend).
 *
 * The agent runs under a signal that aborts on EITHER the job's own
 * `coral-cli abort <jobId>` signal (terminal: aborted/user_abort) OR the
 * scheduler's run signal (terminal: aborted/queue_shutdown), so a daemon stop
 * cancels the in-flight turn instead of blocking on it.
 */
export function createRunCommunitySummaryJob(deps: {
  kb: KbRuntime;
  curateAssistant: CurateAssistantPort;
  recorder: KbJobRecorder;
  projectRoot: string;
}): RunCommunitySummaryJob {
  return async (runSignal: AbortSignal) => {
    const started = deps.recorder.startInternalJob({
      projectRoot: deps.projectRoot,
      operation: 'kb.community_summary',
      request: {},
    });
    const turnSignal = AbortSignal.any([started.signal, runSignal]);

    try {
      const wrote = await runCommunitySummaryAgent(deps.kb, deps.curateAssistant, turnSignal);
      deps.recorder.appendCompleted(
        started.jobId,
        started.startedAtMs,
        wrote ? 'Summarized stale KB communities.' : 'No stale KB communities.',
      );
      return wrote;
    } catch (error: unknown) {
      // An operator `coral-cli abort` carries reason 'user_abort'; a scheduler
      // stop aborts the run signal (no reason) — both are aborts, not failures,
      // so neither should trip the community-batch failure backoff.
      if (isUserAbort(error)) {
        deps.recorder.appendAborted(started.jobId, started.startedAtMs, 'user_abort');
        return false;
      }
      if (isAbortError(error) && runSignal.aborted) {
        deps.recorder.appendAborted(started.jobId, started.startedAtMs, 'queue_shutdown');
        return false;
      }
      const cause = normalizeKbFailureDetail(error);
      deps.recorder.appendOperationFailureWithTerminal({
        jobId: started.jobId,
        projectRoot: deps.projectRoot,
        operation: 'community_summary',
        message: `KB community summary failed: ${cause.message}`,
        detail: { operation: 'community_summary', cause },
        startedAtMs: started.startedAtMs,
      });
      throw error;
    } finally {
      started.finalize();
    }
  };
}
