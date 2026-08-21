import { describe, expect, it } from 'vitest';

import { BackendToolHttpError } from '#src/transport/http/errors.js';
import type { BackendStatusFull } from '#src/transport/http/backend/status.js';
import type { ShutdownResult } from '#src/transport/http/backend/shutdown.js';
import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '#src/discuss/session-types.js';
import type { WatchState } from '#src/discuss/watch.js';
import type { KbReadResult } from '#src/kb/entry-types.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import type { AbortResult } from '#src/jobs/contracts/abort-registry.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { BackendUnreachableError, TransientHttpError } from '#src/infra/http-errors.js';
import { buildErrorEnvelope, UsageError } from '#src/cli/errors.js';
import { formatBackendStatus, formatShutdown } from '#src/cli/format/backend.js';
import {
  formatDiscussAbort,
  formatDiscussParticipate,
  formatDiscussStart,
  formatDiscussWatch,
  formatPersonaSeed,
} from '#src/cli/format/discuss.js';
import { formatErrorEnvelope } from '#src/cli/format/error.js';
import {
  formatAbortResult,
  formatDetachedLaunchStatus,
  formatJobDetail,
  formatJobsList,
  formatLaunch,
  formatLaunchWaitHint,
  renderJobsList,
  type JobsListItem,
} from '#src/cli/format/jobs.js';
import {
  formatKbDelete,
  formatKbMemo,
  formatKbMemoDelete,
  formatKbMemoList,
  formatKbMemoPurge,
  formatKbPrinciples,
  formatKbPromote,
  formatKbRead,
  formatKbReindex,
  formatKbSearch,
  formatKbUpdate,
} from '#src/cli/format/kb.js';
import {
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitWaiting,
  renderWaitLine,
} from '#src/cli/format/wait.js';
import {
  cachedPercent,
  formatCost,
  formatTokens,
  formatUsageSegment,
  totalUsageTokens,
} from '#src/cli/format/usage.js';

const runningDecision = {
  kind: 'provider-session',
  launchState: 'running',
  jobId: 'job-1',
  sessionId: 'session-1',
} satisfies AcceptedLaunchResponse;

const queuedDecision = {
  kind: 'provider-session',
  launchState: 'queued',
  jobId: 'job-2',
  sessionId: 'session-2',
} satisfies AcceptedLaunchResponse;

const workflowDecision = {
  kind: 'workflow',
  launchState: 'running',
  workflowId: 'workflow-1',
  jobId: 'workflow-1',
} satisfies AcceptedLaunchResponse;

const abortOnlyResult = {
  aborted: ['job-1', 'job-2'],
  notFound: [],
} satisfies AbortResult;

const notFoundOnlyResult = {
  aborted: [],
  notFound: ['job-3'],
} satisfies AbortResult;

const mixedAbortResult = {
  aborted: ['job-1'],
  notFound: ['job-9'],
} satisfies AbortResult;

const personaSeedResult = {
  seed_used: 7,
  sigma_used: 1.2,
  pool_size: 100,
  assignments: [
    {
      positions: {
        risk: 'high',
        cost: 'low',
      },
      tone: {
        formality: 'formal',
        evidence: 'data-driven',
        pace: 'concise',
      },
      persona_seed: 11,
      shared_position_with: 0,
      suggested_origin: 'Seoul',
      is_outlier: true,
    },
    {
      positions: {
        risk: 'low',
        cost: 'high',
      },
      tone: {
        formality: 'conversational',
        evidence: 'narrative',
        pace: 'detailed',
      },
      persona_seed: 22,
    },
  ],
} satisfies PersonaSeedOutput;

const bidSpeakResult = {
  action: 'speak',
} satisfies BidResult;

const bidListenResult = {
  action: 'listen',
  speaker: 'alice',
  content: 'Opening statement',
} satisfies BidResult;

const bidEndedResult = {
  action: 'session_ended',
  reason: 'max_epochs_reached',
  content: 'Discussion complete',
} satisfies BidResult;

const speechRecordedResult = {
  action: 'speech_recorded',
} satisfies SpeechResult;

const notYourTurnResult = {
  action: 'not_your_turn',
  current_speaker: 'bob',
} satisfies SpeechResult;

const waitTiming = {
  origin: 'runtime',
  originAt: '2026-07-03T08:00:00.000Z',
  emittedAt: '2026-07-03T08:00:02.000Z',
  elapsedMs: 2_000,
} as const;

const waitProgressEvent = {
  type: 'progress',
  jobId: 'job-1',
  seq: 4,
  message: 'Still running',
  timing: waitTiming,
} satisfies Extract<WaitStreamEvent, { type: 'progress' }>;

const waitQueuedEvent = {
  type: 'queued',
  jobKind: 'provider',
  jobId: 'job-1',
  sessionId: 'session-1',
  queuePosition: 2,
  runningJobIds: ['job-9'],
  timing: { ...waitTiming, origin: 'queued' as const },
} satisfies Extract<WaitStreamEvent, { type: 'queued' }>;

const waitTerminalEvent = {
  type: 'terminal',
  jobId: 'job-1',
  seq: 5,
  remainingJobIds: ['job-2'],
  resultPath: '/tmp/result.md',
  result: {
    content: 'Workflow summary',
    durationMs: 60_000,
    outcome: { kind: 'completed' as const },
  },
} satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

const waitWaitingEvent = {
  type: 'waiting',
  waitingJobIds: ['job-1', 'job-2'],
} satisfies Extract<WaitStreamEvent, { type: 'waiting' }>;

const jobDetailResponse = {
  status: {
    jobId: 'job-1',
    owner: { kind: 'provider-session', id: 'session-1' },
    sessionId: 'session-1',
    provider: 'codex',
    projectRoot: '/work/coral',
    workDir: fixtureCanonicalWorkDir('/work/coral'),
    backendNamespace: 'default',
    jobKind: 'provider',
    phase: 'completed',
    updatedAt: '2026-07-03T08:01:00.000Z',
    lastSeq: 5,
  },
  events: [],
  readiness: 'ready',
  exit: {
    content: 'Workflow summary',
    durationMs: 60_000,
    outcome: { kind: 'completed' },
    diagnostics: {
      progressFaults: [],
      usage: {
        inputTokens: 1_400_000,
        cacheReadTokens: 16_900_000,
        cacheWriteTokens: 60_000,
        outputTokens: 400_000,
        costUsd: 4.18,
      },
    },
    endTime: '2026-07-03T08:02:00.000Z',
  },
} satisfies JobDetailResponse;

describe('cli format', () => {
  describe('formatLaunch', () => {
    it('formats an admitted launch without claiming that execution started', () => {
      expect(formatLaunch(runningDecision)).toBe('Provider job job-1 launch accepted (provider session session-1)');
    });

    it('formats a queued decision', () => {
      expect(formatLaunch(queuedDecision)).toBe('Provider job job-2 queued (provider session session-2)');
    });

    it('distinguishes a workflow aggregate from its observable job', () => {
      expect(formatLaunch(workflowDecision)).toBe('Workflow workflow-1 launch accepted (job workflow-1)');
    });
  });

  describe('formatLaunchWaitHint', () => {
    it('formats the wait command for a detached launch', () => {
      expect(formatLaunchWaitHint(runningDecision)).toBe('Run coral-cli wait jobs job-1 to wait for completion.');
    });
  });

  describe('formatDetachedLaunchStatus', () => {
    it('formats detached launch status without repeating the job id', () => {
      expect(formatDetachedLaunchStatus(runningDecision)).toBe('Provider job running (provider session session-1)');
    });

    it('identifies detached workflows explicitly', () => {
      expect(formatDetachedLaunchStatus(workflowDecision)).toBe('Workflow workflow-1 running (job workflow-1)');
    });
  });

  describe('formatAbortResult', () => {
    it('formats aborted jobs when all requested jobs were found', () => {
      expect(formatAbortResult(abortOnlyResult)).toBe('Aborted jobs: job-1, job-2');
    });

    it('formats a result with only missing jobs', () => {
      expect(formatAbortResult(notFoundOnlyResult)).toBe('No jobs aborted\nNot found: job-3');
    });

    it('formats a result with both aborted and missing jobs', () => {
      expect(formatAbortResult(mixedAbortResult)).toBe('Aborted jobs: job-1\nNot found: job-9');
    });
  });

  describe('formatJobDetail', () => {
    it('renders durable workflow identity for an opaque child job id in list and detail views', () => {
      const childJobId = '11111111-1111-4111-8111-111111111111';
      const workflowJobId = '22222222-2222-4222-8222-222222222222';
      const replacedJobId = '33333333-3333-4333-8333-333333333333';
      const workflowSlotId = `${workflowJobId}:0:1`;
      const child = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          jobId: childJobId,
          owner: { kind: 'workflow' as const, id: workflowJobId },
          parentWorkflowJobId: workflowJobId,
          workflowSlotId,
          workflowSlotGeneration: 1,
          replacesWorkflowJobId: replacedJobId,
        },
      } satisfies JobDetailResponse;

      const list = renderJobsList(
        formatJobsList({ jobs: [{ jobId: childJobId, status: child.status }] }, Date.parse(child.status.updatedAt)),
        { cwd: child.status.projectRoot },
      );
      const detail = formatJobDetail(child);

      expect(list).toContain('SLOT');
      expect(list).toContain('0:1 (g1)');
      expect(detail).toContain(`Parent workflow: ${workflowJobId}`);
      expect(detail).toContain(`Workflow slot: ${workflowSlotId}`);
      expect(detail).toContain('Workflow generation: 1');
      expect(detail).toContain(`Replaces workflow job: ${replacedJobId}`);
    });

    it('renders workflow child ids and replacement lineage in workflow detail', () => {
      const workflowJobId = '22222222-2222-4222-8222-222222222222';
      const firstChildJobId = '11111111-1111-4111-8111-111111111111';
      const replacementJobId = '33333333-3333-4333-8333-333333333333';
      const workflow = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          jobId: workflowJobId,
          owner: { kind: 'workflow' as const, id: workflowJobId },
          sessionId: null,
          provider: null,
          jobKind: 'workflow' as const,
        },
      } satisfies JobDetailResponse;
      const firstChild = {
        jobId: firstChildJobId,
        status: {
          ...jobDetailResponse.status,
          jobId: firstChildJobId,
          owner: { kind: 'workflow' as const, id: workflowJobId },
          parentWorkflowJobId: workflowJobId,
          workflowSlotId: `${workflowJobId}:0:0`,
          workflowSlotGeneration: 0,
        },
      };
      const replacement = {
        jobId: replacementJobId,
        status: {
          ...firstChild.status,
          jobId: replacementJobId,
          workflowSlotGeneration: 1,
          replacesWorkflowJobId: firstChildJobId,
        },
      };

      const detail = formatJobDetail(workflow, undefined, [replacement, firstChild]);

      expect(detail).toContain('Workflow children:');
      expect(detail).toContain('SLOT  GEN  CHILD JOB ID');
      expect(detail).toMatch(new RegExp(`0:0\\s+0\\s+${firstChildJobId}`));
      expect(detail).toMatch(new RegExp(`0:0\\s+1\\s+${replacementJobId}\\s+${firstChildJobId}`));
      expect(detail.indexOf(firstChildJobId)).toBeLessThan(detail.indexOf(replacementJobId));
    });

    /**
     * A workflow child's job id is a uuid that says nothing about which atom ran, so the slot has to be
     * visible — but most jobs occupy no slot, and a column of dashes on every ordinary listing is a cost paid
     * by everyone to inform no one.
     */
    it('omits the slot column entirely when no listed job occupies a workflow slot', () => {
      const list = renderJobsList(
        formatJobsList(
          { jobs: [{ jobId: jobDetailResponse.status.jobId, status: jobDetailResponse.status }] },
          Date.parse(jobDetailResponse.status.updatedAt),
        ),
        { cwd: jobDetailResponse.status.projectRoot },
      );

      expect(list).not.toContain('SLOT');
      expect(list).toContain('JOB ID');
    });

    it('renders the 4-tier usage breakdown with the full cache-read billing annotation', () => {
      expect(formatJobDetail(jobDetailResponse)).toMatchInlineSnapshot(`
        "Job job-1
        Phase: completed
        Readiness: ready
        Provider: codex
        Kind: provider
        Owner: provider-session session-1
        Provider session: session-1
        Project: /work/coral
        Work dir: /work/coral
        Updated: 2026-07-03T08:01:00.000Z
        Last seq: 5
        Exit: completed
        Ended: 2026-07-03T08:02:00.000Z
        Usage:
          $4.18 · input 1.4M · cache-read 16.9M (90%, billed ~0.1×) · cache-write 60.0K · output 400.0K
        Result:
        Workflow summary"
      `);
    });

    it('renders a job without usage without a usage block', () => {
      const withoutUsage = {
        ...jobDetailResponse,
        exit: {
          ...jobDetailResponse.exit,
          diagnostics: { progressFaults: [] },
        },
      } satisfies JobDetailResponse;

      const formatted = formatJobDetail(withoutUsage);

      expect(formatted).not.toContain('Usage:');
      expect(formatted).toContain('Result:\nWorkflow summary');
    });

    it('renders a wait hint while the job is still running', () => {
      const running = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          phase: 'running',
        },
        exit: null,
      } satisfies JobDetailResponse;

      expect(formatJobDetail(running)).toMatchInlineSnapshot(`
        "Job job-1
        Phase: running
        Readiness: ready
        Provider: codex
        Kind: provider
        Owner: provider-session session-1
        Provider session: session-1
        Project: /work/coral
        Work dir: /work/coral
        Updated: 2026-07-03T08:01:00.000Z
        Last seq: 5
        Run coral-cli wait jobs job-1 to follow it."
      `);
    });

    it('renders aborted terminal details from the outcome when content is empty', () => {
      const aborted = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          phase: 'aborted',
        },
        exit: {
          ...jobDetailResponse.exit,
          content: '',
          outcome: { kind: 'aborted' as const, reason: 'user_abort' as const },
          diagnostics: { progressFaults: [] },
        },
      } satisfies JobDetailResponse;

      expect(formatJobDetail(aborted)).toContain('Exit: aborted: user_abort');
      expect(formatJobDetail(aborted)).toContain('Result:\nAborted: user_abort.');
    });

    it('renders failed terminal details through the cause ref describer', () => {
      const failed = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          phase: 'error',
        },
        exit: {
          ...jobDetailResponse.exit,
          content: '',
          outcome: {
            kind: 'failed' as const,
            causeRef: { stream: { kind: 'session' as const, id: 'session-1' }, seq: 4 },
          },
          diagnostics: { progressFaults: [] },
        },
      } satisfies JobDetailResponse;

      const formatted = formatJobDetail(failed, () => 'Claude session failed: transcript missing.');

      expect(formatted).toContain('Exit: Failed: Claude session failed: transcript missing.');
      expect(formatted).toContain('Result:\nFailed: Claude session failed: transcript missing.');
    });

    it('renders job fault terminal details from the fault payload', () => {
      const faulted = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          phase: 'error',
        },
        exit: {
          ...jobDetailResponse.exit,
          content: '',
          outcome: {
            kind: 'job_fault' as const,
            fault: {
              kind: 'wrapper_crashed' as const,
              cause: { message: 'provider timed out' },
            },
          },
          diagnostics: { progressFaults: [] },
        },
      } satisfies JobDetailResponse;

      const formatted = formatJobDetail(faulted, () => 'unused cause ref');

      expect(formatted).toContain('Exit: Provider wrapper crashed: provider timed out.');
      expect(formatted).toContain('Result:\nProvider wrapper crashed: provider timed out.');
    });

    it('omits the Provider line when a workflow job has no provider', () => {
      const workflow = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          owner: { kind: 'workflow' as const, id: 'job-1' },
          sessionId: null,
          provider: null,
          workDir: fixtureCanonicalWorkDir('/work/coral/workflow'),
          jobKind: 'workflow' as const,
        },
      } satisfies JobDetailResponse;

      const formatted = formatJobDetail(workflow);

      expect(formatted).not.toContain('\nProvider:');
      expect(formatted).toContain('\nKind: workflow\n');
      expect(formatted).not.toContain('\nSession:');
      expect(formatted).toContain('\nWork dir: /work/coral/workflow');
    });

    it('omits the Work dir line for a KB job', () => {
      const kb = {
        ...jobDetailResponse,
        status: {
          ...jobDetailResponse.status,
          owner: { kind: 'system-task' as const, id: 'kb.reindex:job-1' },
          sessionId: null,
          provider: null,
          workDir: null,
          jobKind: 'kb' as const,
        },
      } satisfies JobDetailResponse;

      const formatted = formatJobDetail(kb);

      expect(formatted).toContain('\nProject: /work/coral');
      expect(formatted).not.toContain('\nWork dir:');
    });
  });

  describe('formatPersonaSeed', () => {
    it('formats assignments with positions and seed metadata', () => {
      const formatted = formatPersonaSeed(personaSeedResult);

      expect(formatted).toContain('Seed used: 7');
      expect(formatted).toContain('Sigma used: 1.2');
      expect(formatted).toContain('Pool size: 100');
      expect(formatted).toContain('1. risk=high | cost=low');
      expect(formatted).toContain('seed 11');
      expect(formatted).toContain('shared_with 0');
      expect(formatted).toContain('origin Seoul');
      expect(formatted).toContain('outlier');
      expect(formatted).toContain('2. risk=low | cost=high');
      expect(formatted).toContain('tone conversational/narrative/detailed');
      expect(formatted).toContain('seed 22');
    });
  });

  describe('discuss formatters', () => {
    it('formats discuss start output', () => {
      expect(formatDiscussStart({ session: 'session-1' })).toBe('Session started: session-1');
    });

    it('formats discuss abort success', () => {
      expect(formatDiscussAbort({ ok: true, session: 'session-1' })).toBe('Session aborted: session-1');
    });

    it('formats discuss abort failure', () => {
      expect(formatDiscussAbort({ ok: false, session: 'session-1' })).toBe('Abort failed: session-1');
    });

    it('formats a bid result that tells the caller to speak', () => {
      expect(formatDiscussParticipate(bidSpeakResult)).toBe('Your turn to speak');
    });

    it('formats a bid result that tells the caller to listen', () => {
      expect(formatDiscussParticipate(bidListenResult)).toBe('Listen to alice\nOpening statement');
    });

    it('formats a session-ended participate result', () => {
      expect(formatDiscussParticipate(bidEndedResult)).toBe('Session ended: max_epochs_reached\nDiscussion complete');
    });

    it('formats a recorded speech result', () => {
      expect(formatDiscussParticipate(speechRecordedResult)).toBe('Speech recorded');
    });

    it('formats a not-your-turn result with the current speaker', () => {
      expect(formatDiscussParticipate(notYourTurnResult)).toBe('Not your turn (current speaker: bob)');
    });

    it('formats a valid discuss watch payload', () => {
      const result = {
        session: 'session-1',
        status: 'bidding',
        topic: 'Risk tradeoffs',
        epoch: 2,
        step: 3,
        events: [
          {
            type: 'bid_resolved',
            data: { id: 1 },
            ts: 1,
          },
          {
            type: 'speech_done',
            data: { id: 2 },
            ts: 2,
          },
        ],
        cursor: 9,
      } satisfies WatchState;

      expect(formatDiscussWatch(result)).toBe(
        'Session session-1 [bidding]\n' + 'Topic: Risk tradeoffs\n' + 'Epoch: 2 | Step: 3 | Events: 2 | Cursor: 9',
      );
    });

    it('falls back to a generic formatter for invalid watch input', () => {
      expect(formatDiscussWatch({ invalid: true })).toBe('{"invalid":true}');
    });
  });

  describe('backend formatters', () => {
    // The one operator-facing sentence on this branch that had no test. The load-bearing line is the caveat:
    // an unreadable record must not read as a stopped daemon.
    it.each([['corrupt-json'], ['shape-rejected']] as const)(
      'reports a %s discovery record as unknown state, not as not-running',
      (reason) => {
        const text = formatBackendStatus({ status: 'undecodable_record', reason, path: '/run/coral/coordinator.json' });

        expect(text).toContain('could not be read');
        expect(text, 'the caveat is the whole point of the variant').toContain('may still be running');
        expect(text, 'the remedy is "delete this file", so it must name the file').toContain(
          '/run/coral/coordinator.json',
        );
        expect(text).not.toMatch(/Backend not running/u);
      },
    );

    // Each row is a full `ShutdownResult`, not a bare `reason` token: `refused_by_response` and
    // `recorded_process_absent` require `detail`, and `socket_refused` requires `pidLiveness` — a shared
    // generic `detail` fallback no longer type-checks against the discriminated union.
    const SHUTDOWN_REFUSAL_SENTENCES: ReadonlyArray<readonly [Extract<ShutdownResult, { ok: false }>, RegExp]> = [
      [{ ok: false, reason: 'unreadable_record', detail: 'corrupt-json' }, /may still be running/u],
      [
        { ok: false, reason: 'refused_by_response', detail: '500 Internal Server Error' },
        /coordinator responded but did not accept/u,
      ],
      [{ ok: false, reason: 'no_response', detail: 'ETIMEDOUT' }, /did not complete/u],
      [{ ok: false, reason: 'no_record' }, /no coordinator has recorded itself/u],
      [{ ok: false, reason: 'no_record_socket_present' }, /no discovery record has been written yet/u],
      [{ ok: false, reason: 'recorded_process_absent', detail: '4242' }, /recorded coordinator process/u],
      [
        {
          ok: false,
          reason: 'socket_refused',
          pidLiveness: 'alive',
          pid: 4242,
          recordPath: '/run/coral/coordinator.json',
        },
        /socket refused the connection/u,
      ],
      [{ ok: false, reason: 'nested_child' }, /cannot shut down its parent coordinator/u],
    ];

    it.each(SHUTDOWN_REFUSAL_SENTENCES)(
      'renders a shutdown refusal as a sentence, not as a token (%j)',
      (result, expected) => {
        expect(formatShutdown(result)).toMatch(expected);
      },
    );

    // `capability_rejected` is deliberately not a row above — its own tests further down assert the pid-hedging
    // language directly — so this drives completeness off the production exit-code table rather than off
    // `SHUTDOWN_REFUSAL_SENTENCES` alone, the way `errorCodeToExit`'s own completeness test does.
    it('renders a sentence for every ShutdownReason the production table knows about', async () => {
      const { SHUTDOWN_REFUSAL_EXIT_CODES } = await import('#src/cli/commands/backend.js');

      const testedElsewhere = ['capability_rejected'];
      const coveredReasons = [...SHUTDOWN_REFUSAL_SENTENCES.map(([result]) => result.reason), ...testedElsewhere];

      expect(coveredReasons.sort()).toEqual(Object.keys(SHUTDOWN_REFUSAL_EXIT_CODES).sort());
    });

    // `refused_by_response` proves something is listening (a response arrived); `no_response` proves neither
    // way. Neither may claim the backend stopped.
    it('does not claim the backend stopped when a response arrived but was not accepted', () => {
      const text = formatShutdown({ ok: false, reason: 'refused_by_response', detail: '500 Internal Server Error' });

      expect(text).not.toMatch(/did not complete/u);
      expect(text).not.toMatch(/Backend not running/u);
    });

    // `socket_refused` never claims "not running": a refused connection cannot prove absence, because
    // an absent pid is excluded before this request is ever sent. Both liveness values must render a hedge,
    // not a claim that the backend stopped.
    it.each([['alive'], ['unknown']] as const)(
      'does not claim the backend stopped on a refused connection when pidLiveness is %s',
      (pidLiveness) => {
        const text = formatShutdown({
          ok: false,
          reason: 'socket_refused',
          pidLiveness,
          pid: 4242,
          recordPath: '/run/coral/coordinator.json',
        });

        expect(text).not.toMatch(/^Backend not running/mu);
      },
    );

    // Pins both arms of the ternary: inverting it (always rendering the `'alive'` text) leaves every existing
    // assertion in this file green, since both arms match `/socket refused the connection/u` and neither
    // matches `/^Backend not running/mu`. Only a direct check that `'unknown'` does NOT claim a prior
    // confirmation catches that inversion.
    it('says the pid still belongs to a process only when pidLiveness is alive, not unknown', () => {
      const aliveText = formatShutdown({
        ok: false,
        reason: 'socket_refused',
        pidLiveness: 'alive',
        pid: 4242,
        recordPath: '/run/coral/coordinator.json',
      });
      const unknownText = formatShutdown({
        ok: false,
        reason: 'socket_refused',
        pidLiveness: 'unknown',
        pid: 4242,
        recordPath: '/run/coral/coordinator.json',
      });

      expect(aliveText, 'alive observed a process holding that pid').toMatch(
        /pid 4242 still belongs to a running process/u,
      );
      expect(unknownText, 'unknown observed neither').not.toMatch(/still belongs to a running process/u);
      // The remedy names both things it asks the operator to act on; a sentence telling them to check a pid
      // it does not print, and delete a file whose path it does not give, is a next step only in form.
      expect(aliveText, 'the pid the operator is told to check').toMatch(/ps -p 4242/u);
      expect(aliveText, 'the record the operator is told to delete').toMatch(/\/run\/coral\/coordinator\.json/u);
      // `observeProcessLiveness` is a bare `kill(pid, 0)`, so the sentence may not upgrade "some process holds
      // this number" into "Coral's coordinator is running" — the overclaim this arm shipped with.
      expect(aliveText, 'a bare pid probe cannot identify the program holding the pid').not.toMatch(
        /coordinator process was confirmed running/u,
      );
    });

    // Each must say what was actually looked at.
    it('does not claim a socket dial for no_record, which never made one', () => {
      const text = formatShutdown({ ok: false, reason: 'no_record' });

      expect(text, 'only socket_refused observed the socket').not.toMatch(/socket refused|listening/u);
    });

    it('does not claim a socket dial for recorded_process_absent, which never made one', () => {
      const text = formatShutdown({ ok: false, reason: 'recorded_process_absent', detail: '4242' });

      expect(text, 'only socket_refused observed the socket').not.toMatch(/socket refused|listening/u);
    });
    const baseHealth = {
      status: 'ok' as const,
      version: '1.2.3',
      bundleHash: 'bundle-hash',
      instanceId: 'instance-1',
      uptimeMs: 252_000,
      active: 2,
      activeJobs: 1,
      inflightRequests: 0,
      textProjectionState: 'idle' as const,
      kernel: { phase: 'running' as const, readyAt: Date.parse('2026-05-05T12:00:00.000Z') },
    };

    it('formats a running backend status with online components', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          components: [{ id: 'kb', phase: 'online' as const }],
          queueDepth: 0,
        },
      } satisfies BackendStatusFull;

      expect(formatBackendStatus(status)).toBe(
        [
          'Backend ok',
          'Version: 1.2.3',
          'Uptime: 4m12s',
          'Kernel: running since 2026-05-05T12:00:00.000Z',
          'System provider scope: unconfigured',
          '',
          'Runtime Components:',
          '  kb: online',
          '',
          'Active jobs: 1',
          'Queue depth: 0',
        ].join('\n'),
      );
    });

    it('formats the redacted system provider scope without profile details', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          systemProviderScope: { name: 'maintenance', providers: ['claude', 'codex'] },
          components: [],
        },
      } satisfies BackendStatusFull;

      expect(formatBackendStatus(status)).toContain('System provider scope: maintenance (claude, codex)');
    });

    it('omits the kernel timestamp when readyAt is null', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          kernel: { phase: 'starting' as const, readyAt: null },
          components: [{ id: 'kb', phase: 'initializing' as const, attempt: 2 }],
        },
      } satisfies BackendStatusFull;

      const output = formatBackendStatus(status);
      expect(output).toContain('Kernel: starting\n');
      expect(output).not.toContain(' since ');
      expect(output).toContain('  kb: initializing\n    attempt: 2');
    });

    it('formats a degraded component with reason kind, details, and last error', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          components: [
            {
              id: 'kb',
              phase: 'degraded' as const,
              reason: {
                kind: 'curate-publish' as const,
                consecutiveFailures: 3,
                lastError: 'publish timed out',
              },
            },
          ],
        },
      } satisfies BackendStatusFull;

      const output = formatBackendStatus(status);
      expect(output).toContain('  kb: degraded');
      expect(output).toContain('    reason: curate-publish (3 consecutive failures)');
      expect(output).toContain('    last error: publish timed out');
      expect(output).toContain('    hint: free disk space, then coral-cli backend shutdown to reset');
    });

    it('omits the last-error line for a degraded component when lastError is empty', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          components: [
            {
              id: 'kb',
              phase: 'degraded' as const,
              reason: {
                kind: 'curate-publish' as const,
                consecutiveFailures: 1,
                lastError: '',
              },
            },
          ],
        },
      } satisfies BackendStatusFull;

      expect(formatBackendStatus(status)).not.toContain('last error:');
    });

    it('formats an offline component with reason, last log, and shutdown hint', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          components: [
            {
              id: 'kb',
              phase: 'offline' as const,
              reason: 'binding_empty after 3 attempts',
              lastLogLine: '[component:kb] catalog scan failed',
              diagnostic: {
                attempts: 4,
                failedStep: 'I2 corpus freshness rescan',
                retry: 'restart-daemon' as const,
                lastErrorStack: 'Error: binding_empty after 3 attempts',
              },
            },
          ],
        },
      } satisfies BackendStatusFull;

      const output = formatBackendStatus(status);
      expect(output).toContain('  kb: offline');
      expect(output).toContain('    reason: binding_empty after 3 attempts');
      expect(output).toContain('    last log: [component:kb] catalog scan failed');
      expect(output).toContain('    failed step: I2 corpus freshness rescan');
      expect(output).toContain('    attempts: 4');
      expect(output).toContain('    retry: daemon restart required');
      expect(output).not.toContain('lastErrorStack');
      expect(output).toContain('    hint: restart the daemon: coral-cli backend shutdown');
    });

    it('omits the last-log line for an offline component when lastLogLine is absent', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          components: [{ id: 'kb', phase: 'offline' as const, reason: 'binding_empty' }],
        },
      } satisfies BackendStatusFull;

      const output = formatBackendStatus(status);
      expect(output).toContain('  kb: offline');
      expect(output).not.toContain('last log:');
      expect(output).toContain('    hint: restart the daemon: coral-cli backend shutdown');
    });

    it('points a non-retryable offline component at the failure details and reindex recovery', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          components: [
            {
              id: 'kb',
              phase: 'offline' as const,
              reason: 'binding_empty',
              diagnostic: { retry: 'none' as const },
            },
          ],
        },
      } satisfies BackendStatusFull;

      const output = formatBackendStatus(status);
      expect(output).toContain('    retry: not retryable');
      expect(output).toContain(
        '    hint: review the failure details above; coral-cli kb reindex can rebuild a corrupt KB index',
      );
    });

    it('omits the queue-depth line when queueDepth is absent', () => {
      const status = {
        status: 'ok',
        health: {
          ...baseHealth,
          components: [{ id: 'kb', phase: 'online' as const }],
        },
      } satisfies BackendStatusFull;

      expect(formatBackendStatus(status)).not.toContain('Queue depth');
    });

    it('formats a not-running backend status with a recovery hint', () => {
      expect(formatBackendStatus({ status: 'not_running' })).toBe(
        'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.',
      );
    });

    // `formatBackendStatus`'s `unreachable` case had no test anywhere. The load-bearing part is that the
    // "something is listening" claim is conditional: it is true only when an HTTP response was actually
    // received (`cause: 'responded'`), and must not be printed for a refusal or a request that never completed.
    it('claims something is listening only when a response was actually received', () => {
      const text = formatBackendStatus({
        status: 'unreachable',
        detail: '500 Internal Server Error',
        cause: 'responded',
      });

      expect(text).toContain('did not give a usable answer (500 Internal Server Error)');
      expect(text, 'a response proves something is listening').toMatch(/is listening at the recorded address/u);
      expect(text).not.toMatch(/Backend not running/u);
    });

    it('does not claim anything is listening when the request never completed', () => {
      const text = formatBackendStatus({ status: 'unreachable', detail: 'ECONNRESET', cause: 'no_response' });

      expect(text).toContain('did not give a usable answer (ECONNRESET)');
      // The false claim this guards against: nothing here proves a socket is open, let alone that anything
      // answers on it.
      expect(text, 'no response was received, so nothing here proves anything is listening').not.toMatch(
        /is listening at the recorded address/u,
      );
      expect(text).not.toMatch(/Backend not running/u);
    });

    // A refusal proves the opposite of `responded`: nothing was listening on that exact socket at that moment.
    // But that is not the same as a confirmed-absent backend, since a coordinator's HTTP listener can close
    // mid-drain while its process, already confirmed alive, keeps running — hence the `pidLiveness` hedge.
    it.each([
      ['alive', /pid still belongs to a running process/u],
      ['unknown', /could not be independently confirmed alive or gone/u],
    ] as const)('claims nothing is listening on a refusal, hedged by pidLiveness %s', (pidLiveness, expected) => {
      const text = formatBackendStatus({
        status: 'unreachable',
        detail: 'ECONNREFUSED',
        cause: 'refused',
        pidLiveness,
        pid: 4242,
        recordPath: '/run/coral/coordinator.json',
      });

      expect(text).toContain('did not give a usable answer (ECONNREFUSED)');
      expect(text, 'a refusal proves nothing is listening at that moment').toMatch(
        /Nothing is listening at the recorded address/u,
      );
      expect(text).toMatch(expected);
      expect(text).not.toMatch(/is listening at the recorded address; this is not a report/u);
      expect(text).not.toMatch(/Backend not running/u);
    });

    // `backend shutdown` already resolves the identical evidence (a reused pid never clears by retrying) with
    // a check-and-clear remedy; a refused `backend status` probe used to end at "check the coordinator logs",
    // a hold with no exit for the one case that cannot end by retrying.
    it('names the same check-and-clear remedy backend shutdown offers for a refused connection', () => {
      const text = formatBackendStatus({
        status: 'unreachable',
        detail: 'ECONNREFUSED',
        cause: 'refused',
        pidLiveness: 'alive',
        pid: 4242,
        recordPath: '/run/coral/coordinator.json',
      });

      expect(text).toMatch(/ps -p 4242/u);
      expect(text).toContain('/run/coral/coordinator.json');
      expect(text).toMatch(/coral-cli mutating command to relaunch/u);
    });

    // Not "not running": the coordinator's own IPC socket exists with no record written yet, so a boot in
    // progress and a stale leftover socket read the same and neither may claim the backend is running or gone.
    it('formats a no_record_socket_present status without claiming the backend is running or stopped', () => {
      const text = formatBackendStatus({
        status: 'no_record_socket_present',
        socketPath: '/run/coral/coordinator.sock',
      });

      expect(text).toContain('/run/coral/coordinator.sock');
      expect(text).toMatch(/no discovery record has been written yet/u);
      expect(text).not.toMatch(/Backend not running/u);
    });

    it('formats a recent coordinator failure with its phase and log guidance', () => {
      expect(
        formatBackendStatus({
          status: 'recent_failure',
          phase: 'startup_failed',
        }),
      ).toBe(
        [
          'Backend is not running after a recent coordinator failure.',
          'Phase: startup_failed',
          'Next step: inspect the coordinator log, fix the reported cause, then retry a coral-cli mutating command to relaunch it.',
        ].join('\n'),
      );
    });

    it('formats a documented startup failure with its authored cause and remediation', () => {
      expect(
        formatBackendStatus({
          status: 'recent_failure',
          phase: 'startup_failed',
          setupError: {
            code: 'store_newer_incompatible',
            userMessage:
              'The current-generation store was written by newer Coral 0.11.0 and is incompatible with this build.',
            remediation:
              "Use Coral 0.11.0 to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor prod'.",
          },
        }),
      ).toBe(
        [
          'Backend is not running after a recent coordinator failure.',
          'Phase: startup_failed',
          'Cause: The current-generation store was written by newer Coral 0.11.0 and is incompatible with this build. [code=store_newer_incompatible]',
          "Next step: Use Coral 0.11.0 to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor prod'.",
        ].join('\n'),
      );
    });

    it('formats a shutting-down backend status', () => {
      expect(formatBackendStatus({ status: 'shutting_down' })).toBe('Backend shutting down');
    });

    it('formats an unauthorized backend status with a recovery hint', () => {
      expect(formatBackendStatus({ status: 'unauthorized' })).toBe(
        'Backend unauthorized. The discovery record and daemon token disagree — run coral-cli backend shutdown, then retry to relaunch with a fresh token.',
      );
    });

    it('formats a successful shutdown result', () => {
      const result = { ok: true } satisfies ShutdownResult;
      expect(formatShutdown(result)).toBe('Backend shutdown initiated');
    });

    // `alreadyDraining` was produced by `shutdownBackend` and asserted in its own test, but `formatShutdown`
    // rendered it identically to a fresh shutdown it had just initiated — telling an operator this request
    // started a drain that was, in fact, already under way before it was sent.
    it('formats an already-draining shutdown result distinctly from a freshly initiated one', () => {
      const result = { ok: true, alreadyDraining: true } satisfies ShutdownResult;
      expect(formatShutdown(result)).toBe('Backend shutdown already in progress');
      expect(formatShutdown(result)).not.toBe('Backend shutdown initiated');
    });

    // Was `reason: 'unauthorized'` — a token no producer emits, pinning the raw-token render that the closed
    // union and the exhaustive switch now make impossible to reach.
    it('formats a rejected shutdown capability as a refusal that names an exit', () => {
      const result = {
        ok: false,
        reason: 'capability_rejected',
        detail: '4242',
        pidLiveness: 'alive',
      } satisfies ShutdownResult;
      expect(formatShutdown(result)).toMatch(/rejected the boot token/u);
      expect(formatShutdown(result), 'the coordinator is up; this is not a report that it stopped').toMatch(
        /did not accept the request/u,
      );
      // A refusal with nothing an operator can do is the shape §11 forbids, and this one said "needs manual
      // intervention" while naming neither the process nor a command. The pid comes from our own record, and
      // it is the only handle on a coordinator that will not accept our token.
      expect(formatShutdown(result), 'the live coordinator is identified').toMatch(/pid 4242/u);
      expect(formatShutdown(result), 'and the next step is a command that exists').toMatch(/coral-cli backend status/u);
      expect(formatShutdown(result), 'retrying is the one thing that cannot work here').toMatch(/no retry/u);
    });

    // The 401 proves a coordinator answers at the address; it does not itself prove the recorded pid is that
    // coordinator. `pidLiveness: 'unknown'` is what `observeCoordinator` had already found before this request
    // was ever sent, and the sentence must not promise more certainty about the pid than that.
    it('hedges the pid claim when its liveness was never independently confirmed', () => {
      const result = {
        ok: false,
        reason: 'capability_rejected',
        detail: '4242',
        pidLiveness: 'unknown',
      } satisfies ShutdownResult;
      const text = formatShutdown(result);

      expect(text).toMatch(/rejected the boot token/u);
      expect(text, 'the pid is still named').toMatch(/4242/u);
      expect(text, 'but confirmed liveness is not claimed for it').not.toMatch(/^It is running \(pid/mu);
      expect(text, 'the hedge itself is present').toMatch(/not independently confirmed alive/u);
      expect(text, 'and the next step is a command that exists').toMatch(/coral-cli backend status/u);
    });

    // Neither remedy is reachable through a coral-cli command: `shutdownBackend` refuses on an unreadable
    // record before it ever dials, since host/port/bootToken all live in the record it could not read.
    it('does not tell the operator to run a coral-cli command that cannot reach an unreadable record', () => {
      const statusText = formatBackendStatus({
        status: 'undecodable_record',
        reason: 'corrupt-json',
        path: '/run/coral/coordinator.json',
      });
      const shutdownText = formatShutdown({ ok: false, reason: 'unreadable_record', detail: 'corrupt-json' });

      for (const text of [statusText, shutdownText]) {
        expect(text, 'no invented command is offered').not.toMatch(/stop any running coordinator/u);
        expect(text, 'the only reachable exit is stopping the process by hand').toMatch(
          /find and stop that process yourself|stop a coordinator whose own record/u,
        );
      }
    });
  });

  describe('kb formatters', () => {
    it('formats hybrid kb search results as JSON, adds an indicator, and rewrites kb_reindex warnings', () => {
      const formatted = formatKbSearch(
        {
          results: [
            {
              note: 'cli-kb-tooling',
              kind: 'note',
              title: 'KB CLI Tooling',
              matchedBy: ['filename', 'content'],
              tags: ['cli', 'kb'],
              principles: ['contract-first-design'],
              snippet: 'Use kb_reindex after stale writes.',
              evidence: [],
            },
          ],
          mode: 'hybrid',
          warning: 'Enhanced KB index is stale; run kb_reindex to refresh it.',
          retrievalDiagnostics: [],
        },
        'node "/tmp/coral-cli.cjs"',
      );

      const parsed = JSON.parse(formatted);
      expect(parsed.count).toBe(1);
      expect(parsed.indicator).toBe('[hybrid]');
      expect(parsed.results[0].note).toBe('cli-kb-tooling');
      expect(parsed.results[0].kind).toBe('note');
      expect(parsed.warning).toContain('node "/tmp/coral-cli.cjs" kb reindex');
    });

    it('formats an empty kb search result set', () => {
      const parsed = JSON.parse(formatKbSearch({ results: [], mode: 'text', retrievalDiagnostics: [] }));
      expect(parsed.count).toBe(0);
    });

    it('formats vector kb search results with a vector indicator and warning codes', () => {
      const parsed = JSON.parse(
        formatKbSearch({
          results: [],
          mode: 'vector',
          warnings: ['kb_search_degraded_until_coordinator_rebuild'],
          retrievalDiagnostics: [],
        }),
      );

      expect(parsed.indicator).toBe('[vector]');
      expect(parsed.warnings).toEqual(['Search index is unavailable; start the Coral backend to rebuild it.']);
    });

    it('formats kb read note payloads as JSON', () => {
      const formatted = formatKbRead({
        kind: 'note',
        note: 'coral-kb-read',
        title: 'Read Test',
        content: '## Rule\nContent here.',
        tags: ['coral', 'kb'],
        principles: ['contract-first-design'],
      });
      const parsed = JSON.parse(formatted);
      expect(parsed.note).toBe('coral-kb-read');
      expect(parsed.title).toBe('Read Test');
      expect(parsed.content).toBe('## Rule\nContent here.');
      expect(parsed.tags).toEqual(['coral', 'kb']);
      expect(parsed.principles).toEqual(['contract-first-design']);
    });

    it('formats kb read principle payloads as JSON', () => {
      const formatted = formatKbRead({
        kind: 'principle',
        note: 'contract-first-design',
        title: 'contract-first-design',
        content: 'State contracts first.',
        rawContent: '---\ncreatedAt: 2026-03-23\nupdatedAt: 2026-03-23\n---\nState contracts first.\n',
        tags: [],
        principles: [],
      });
      const parsed = JSON.parse(formatted);
      expect(parsed.kind).toBe('principle');
      expect(parsed.note).toBe('contract-first-design');
      expect(parsed.content).toBe('State contracts first.');
      expect(parsed.rawContent).toContain('createdAt: 2026-03-23');
      expect(parsed.tags).toEqual([]);
      expect(parsed.principles).toEqual([]);
    });

    it('formats kb memo write, list, delete, and purge results', () => {
      expect(formatKbMemo({ filename: '20260327-184939-kb.md', path: '/tmp/memos/20260327-184939-kb.md' })).toBe(
        'Memo: 20260327-184939-kb.md',
      );
      expect(
        formatKbMemoList({
          memos: [{ filename: 'a.md', summary: 'summary', createdAt: '2026-03-27T00:00:00.000Z' }],
        }),
      ).toBe(
        'FILENAME  SUMMARY  CREATED AT              \n' +
          '--------  -------  ------------------------\n' +
          'a.md      summary  2026-03-27T00:00:00.000Z',
      );
      expect(formatKbMemoList({ memos: [] })).toBe('No memos');
      expect(formatKbMemoDelete({ deleted: ['a.md', 'b.md'], count: 2 })).toBe('a.md\nb.md\nCount: 2');
      expect(formatKbMemoDelete({ deleted: [], count: 0 })).toBe('No memos deleted\nCount: 0');
      expect(formatKbMemoPurge({ deleted: 3 })).toBe('Purged: 3 memos');
    });

    it('does not mutate kb read results when deriving age text', () => {
      const result = {
        kind: 'note',
        note: 'coral-kb-read',
        title: 'Read Test',
        content: '## Rule\nContent here.',
        tags: ['coral', 'kb'],
        principles: ['contract-first-design'],
        updatedAt: '2026-03-23T00:00:00.000Z',
      } satisfies KbReadResult;

      formatKbRead(result);

      expect('age' in result).toBe(false);
    });

    it('formats kb principles with totals and warning translation', () => {
      expect(
        formatKbPrinciples({
          principles: ['contract-first-design', 'single-source-of-truth'],
          total: 2,
          warning: 'No index found. Run kb_reindex first.',
        }),
      ).toBe(
        'contract-first-design\n' +
          'single-source-of-truth\n' +
          'Total: 2\n' +
          'Warning: No index found. Run coral-cli kb reindex first.',
      );
    });

    it('formats verbose kb principles with note lists', () => {
      expect(
        formatKbPrinciples({
          principles: [
            {
              name: 'contract-first-design',
              statement: 'State contracts first.',
              notes: ['a-note', 'b-note'],
            },
          ],
          total: 2,
        }),
      ).toBe('contract-first-design (a-note, b-note): State contracts first.\nTotal: 2');
    });

    it('formats an empty kb principles result', () => {
      expect(formatKbPrinciples({ principles: [], total: 0 })).toBe('No principles\nTotal: 0');
    });

    it('formats kb promote, update, and delete results with slug-only output (paths hidden from LLM)', () => {
      expect(formatKbPromote({ path: '/tmp/kb/notes/cli-kb-tooling.md' })).toBe('Promoted note: cli-kb-tooling');
      expect(formatKbUpdate({ path: '/tmp/kb/notes/cli-kb-tooling.md' })).toBe('Updated note: cli-kb-tooling');
      expect(formatKbDelete({ deleted: '/tmp/kb/notes/cli-kb-tooling.md' })).toBe('Deleted note: cli-kb-tooling');
    });

    it('formats kb reindex as one-liner and rewrites kb_reindex warnings', () => {
      const formatted = formatKbReindex(
        {
          notes: 4,
          sources: 0,
          communities: 0,
          wikis: 0,
          principles: 2,
          tags: 3,
          duration_ms: 25,
          mode: 'text',
          warning: 'Run kb_reindex again to refresh the enhanced index.',
        },
        'node "/tmp/coral-cli.cjs"',
      );

      expect(formatted).toBe(
        'Reindexed: 4 notes, 0 communities, 0 wikis, 2 principles, 3 tags (25ms, text)\n' +
          'Warning: Run node "/tmp/coral-cli.cjs" kb reindex again to refresh the enhanced index.',
      );
    });

    it('formats async kb reindex job launch results', () => {
      expect(formatKbReindex({ status: 'running', job: 'kb-reindex-job' })).toBe('Reindex job kb-reindex-job running');
    });
  });

  describe('formatErrorEnvelope', () => {
    it('formats UsageError envelopes on a single line', () => {
      const { envelope } = buildErrorEnvelope(new UsageError('input is required (-i, --input)'));

      expect(formatErrorEnvelope(envelope)).toBe('input is required (-i, --input) [code=invalid_usage]');
    });

    it('keeps BackendToolHttpError diagnostics out of the default text surface', () => {
      const error = new BackendToolHttpError('HTTP 503', 503, {
        code: 'backend_recovering',
        message: 'recovering — retry after 500ms',
        remediation: 'Retry after the backend finishes recovery.',
        detail: { retryAfterMs: 500 },
      });
      const { envelope } = buildErrorEnvelope(error);

      expect(formatErrorEnvelope(envelope, error.statusCode)).toBe(
        'recovering — retry after 500ms [code=backend_recovering, http=503]\n' +
          'remediation: Retry after the backend finishes recovery.',
      );
    });

    it('formats BackendToolHttpError envelopes without detail on a single line', () => {
      const error = new BackendToolHttpError('HTTP 404', 404, {
        code: 'not_found',
        message: 'Job not found',
      });
      const { envelope } = buildErrorEnvelope(error);

      expect(formatErrorEnvelope(envelope, error.statusCode)).toBe('Job not found [code=not_found, http=404]');
    });

    it('omits null BackendToolHttpError detail', () => {
      const error = new BackendToolHttpError('HTTP 400', 400, {
        code: 'bad_request',
        message: 'Missing prompt',
        detail: null,
      });
      const { envelope } = buildErrorEnvelope(error);

      expect(formatErrorEnvelope(envelope, error.statusCode)).toBe('Missing prompt [code=bad_request, http=400]');
    });

    it('does not normalize multi-line envelope heads while omitting diagnostics', () => {
      const formatted = formatErrorEnvelope(
        {
          error: true,
          code: 'bad_request',
          message: 'line one\nline two',
          detail: { field: 'prompt' },
        },
        400,
      );

      expect(formatted.split('\n')).toEqual(['line one', 'line two [code=bad_request, http=400]']);
    });

    it('formats BackendUnreachableError envelopes on a single line with recovery guidance', () => {
      const { envelope } = buildErrorEnvelope(new BackendUnreachableError('fetch failed'));

      expect(formatErrorEnvelope(envelope)).toBe(
        "fetch failed Run 'coral-cli backend status' to diagnose. [code=backend_unreachable]",
      );
    });

    it('does not duplicate the backend status hint when it is already present', () => {
      expect(
        formatErrorEnvelope({
          error: true,
          code: 'backend_unreachable',
          message: 'fetch failed. Run coral-cli backend status for more detail.',
        }),
      ).toBe('fetch failed. Run coral-cli backend status for more detail. [code=backend_unreachable]');
    });

    it('formats TransientHttpError envelopes on a single line', () => {
      const { envelope } = buildErrorEnvelope(new TransientHttpError(503, 'backend warming up'));

      expect(formatErrorEnvelope(envelope)).toBe('backend warming up [code=transient]');
    });

    it('formats plain Error envelopes on a single line', () => {
      const { envelope } = buildErrorEnvelope(new Error('boom'));

      expect(formatErrorEnvelope(envelope)).toBe('boom [code=internal]');
    });

    it.each([
      {
        label: 'structural backend object',
        error: {
          statusCode: 403,
          body: { code: 'scope_mismatch', message: 'Scope mismatch' },
          message: 'Backend request failed: 403 Forbidden',
        },
        expectedEnvelope: 'Scope mismatch [code=scope_mismatch, http=403]',
      },
      {
        label: 'plain Error instance',
        error: new Error('boom'),
        expectedEnvelope: 'boom [code=internal]',
      },
    ])('builds the rendered envelope for $label', ({ error, expectedEnvelope }) => {
      const { envelope } =
        error instanceof Error
          ? buildErrorEnvelope(error)
          : buildErrorEnvelope(new BackendToolHttpError(error.message, error.statusCode, error.body));
      const statusCode = error instanceof Error ? undefined : error.statusCode;

      expect(formatErrorEnvelope(envelope, statusCode)).toBe(expectedEnvelope);
    });
  });

  describe('wait formatters', () => {
    it('formats usage primitives for cost, token magnitude, derived totals, and cached percentage', () => {
      const usage = {
        inputTokens: 1_400_000,
        cacheReadTokens: 16_740_000,
        cacheWriteTokens: 60_000,
        outputTokens: 400_000,
        costUsd: 4.18,
      };

      expect(formatCost(0.34)).toBe('$0.34');
      expect(formatCost(0.004)).toBe('<$0.01');
      expect(formatTokens(941)).toBe('941');
      expect(formatTokens(37_200)).toBe('37.2K');
      expect(formatTokens(18_600_000)).toBe('18.6M');
      expect(totalUsageTokens(usage)).toBe(18_600_000);
      expect(cachedPercent(usage)).toBe(90);
      expect(cachedPercent({ inputTokens: 600, cacheReadTokens: 400 })).toBeUndefined();
    });

    it('renders cost-only usage in light and verbose modes but omits empty usage', () => {
      expect(formatUsageSegment({ costUsd: 0.34 })).toBe('$0.34');
      expect(formatUsageSegment({ costUsd: 0.34 }, { verbose: true })).toBe('$0.34');
      expect(formatUsageSegment({})).toBeUndefined();
    });

    it('pluralizes the missing-cost note for one workflow child', () => {
      expect(formatUsageSegment({ costUsd: 0.5, jobsWithoutCostData: 1 })).toBe('$0.50+ · (+1 job without cost data)');
    });

    it('formats progress events with elapsed time when no label is passed (single-job case)', () => {
      expect(formatWaitProgress(waitProgressEvent)).toBe('[ 0m  2s] Still running');
    });

    it('formats queued events with elapsed time when no label is passed (single-job case)', () => {
      expect(formatWaitQueued(waitQueuedEvent)).toBe('[ 0m  2s] queued at position 2');
    });

    it('formats queued events with elapsed time and caller-supplied positional label (multi-job case)', () => {
      expect(formatWaitQueued(waitQueuedEvent, 'j1')).toBe('[ 0m  2s] j1 - queued at position 2');
    });

    it('injects the positional label after the elapsed time on progress messages', () => {
      const event = { ...waitProgressEvent, message: '0-arc Thread ready' };
      expect(formatWaitProgress(event, 'j0')).toBe('[ 0m  2s] j0 - 0-arc Thread ready');
    });

    it('formats hour-scale elapsed values', () => {
      const event = { ...waitProgressEvent, timing: { ...waitTiming, elapsedMs: 3_723_000 } };
      expect(formatWaitProgress(event, 'j0')).toBe('[1h 02m 03s] j0 - Still running');
    });

    it('keeps full jobId on terminal events without surrounding brackets', () => {
      const longId = '3ee5b730-31b3-46ed-8efe-0127b24e2cfa';
      expect(formatWaitTerminal({ ...waitTerminalEvent, jobId: longId }, null, false)).toContain(
        `Job ${longId} completed`,
      );
    });

    it('formats a non-inline terminal event with the result path and a continuation command', () => {
      expect(formatWaitTerminal(waitTerminalEvent, null, false)).toBe(
        'Job job-1 completed\n' +
          'Result path: /tmp/result.md\n' +
          'Run coral-cli wait jobs job-2 to continue waiting.',
      );
    });

    it('snapshots light wait terminal usage with cost, derived tokens, and cached percentage', () => {
      expect(
        formatWaitTerminal(
          {
            ...waitTerminalEvent,
            usage: {
              inputTokens: 1_400_000,
              cacheReadTokens: 16_740_000,
              cacheWriteTokens: 60_000,
              outputTokens: 400_000,
              costUsd: 4.18,
            },
          },
          null,
          false,
        ),
      ).toMatchInlineSnapshot(`
        "Job job-1 completed · $4.18 · 18.6M tokens (90% cached)
        Result path: /tmp/result.md
        Run coral-cli wait jobs job-2 to continue waiting."
      `);
    });

    it('snapshots verbose wait terminal usage as a full token-bucket breakdown', () => {
      expect(
        formatWaitTerminal(
          {
            ...waitTerminalEvent,
            usage: {
              inputTokens: 1_400_000,
              cacheReadTokens: 16_740_000,
              cacheWriteTokens: 60_000,
              outputTokens: 400_000,
              costUsd: 4.18,
            },
          },
          null,
          false,
          { verbose: true },
        ),
      ).toMatchInlineSnapshot(`
        "Job job-1 completed · $4.18 · input 1.4M · cache-read 16.7M (90% cached) · cache-write 60.0K · output 400.0K
        Result path: /tmp/result.md
        Run coral-cli wait jobs job-2 to continue waiting."
      `);
    });

    it('snapshots no-cost wait terminal usage as tokens-only with cached percentage', () => {
      expect(
        formatWaitTerminal(
          {
            ...waitTerminalEvent,
            usage: {
              inputTokens: 12_979,
              cacheReadTokens: 142_720,
              outputTokens: 707,
            },
          },
          null,
          false,
        ),
      ).toMatchInlineSnapshot(`
        "Job job-1 completed · 156.4K tokens (91% cached)
        Result path: /tmp/result.md
        Run coral-cli wait jobs job-2 to continue waiting."
      `);
    });

    it('snapshots workflow mixed-provider usage with partial-cost honesty', () => {
      expect(
        formatWaitTerminal(
          {
            ...waitTerminalEvent,
            usage: {
              inputTokens: 1_000,
              cacheReadTokens: 1_000,
              outputTokens: 500,
              costUsd: 0.5,
              jobsWithoutCostData: 1,
            },
          },
          null,
          false,
        ),
      ).toMatchInlineSnapshot(`
        "Job job-1 completed · $0.50+ · 2.5K tokens · (+1 job without cost data)
        Result path: /tmp/result.md
        Run coral-cli wait jobs job-2 to continue waiting."
      `);
    });

    it('snapshots cost-only wait terminal usage', () => {
      expect(
        formatWaitTerminal(
          {
            ...waitTerminalEvent,
            usage: {
              costUsd: 0.34,
            },
          },
          null,
          false,
        ),
      ).toMatchInlineSnapshot(`
        "Job job-1 completed · $0.34
        Result path: /tmp/result.md
        Run coral-cli wait jobs job-2 to continue waiting."
      `);
    });

    it('snapshots empty wait terminal usage without adding a usage segment', () => {
      expect(
        formatWaitTerminal(
          {
            ...waitTerminalEvent,
            usage: {},
          },
          null,
          false,
        ),
      ).toMatchInlineSnapshot(`
        "Job job-1 completed
        Result path: /tmp/result.md
        Run coral-cli wait jobs job-2 to continue waiting."
      `);
    });

    it('snapshots aborted wait terminal usage with partial spend', () => {
      expect(
        formatWaitTerminal(
          {
            ...waitTerminalEvent,
            result: {
              content: '',
              durationMs: 60_000,
              outcome: { kind: 'aborted' as const, reason: 'signal_abort' },
            },
            usage: {
              inputTokens: 200,
              outputTokens: 741,
              costUsd: 0.004,
            },
          },
          null,
          false,
        ),
      ).toMatchInlineSnapshot(`
        "Job job-1 aborted: signal_abort · <$0.01 · 941 tokens
        Result path: /tmp/result.md
        Run coral-cli wait jobs job-2 to continue waiting."
      `);
    });

    it('reports when no jobs remain on a non-inline terminal event', () => {
      const event = { ...waitTerminalEvent, remainingJobIds: [] };
      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 completed\n' + 'Result path: /tmp/result.md\n' + 'No remaining jobs.',
      );
    });

    it('includes multiple remaining jobIds in the continuation command', () => {
      const event = { ...waitTerminalEvent, remainingJobIds: ['job-a', 'job-b', 'job-c'] };
      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 completed\n' +
          'Result path: /tmp/result.md\n' +
          'Run coral-cli wait jobs job-a job-b job-c to continue waiting.',
      );
    });

    it('formats an inline terminal event with a content preview, omitting the continuation on a zero exit', () => {
      // `waitTerminalEvent` has a job remaining, but a `completed` outcome exits 0 — `followJobs` reconnects
      // by itself, so the continuation line (a no-op instruction here) stays suppressed even inline.
      expect(formatWaitTerminal(waitTerminalEvent, null, true, { exitCode: 0 })).toBe(
        'Job job-1 completed\n' + 'Result path: /tmp/result.md\n' + 'Workflow summary',
      );
    });

    it('formats provider_exit with a zero code, omitting the continuation on a zero exit', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
          durationMs: 60_000,
          outcome: { kind: 'provider_exit' as const, code: 0 },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(formatWaitTerminal(event, null, true, { exitCode: 0 })).toBe(
        'Job job-1 provider exited 0\n' + 'Result path: /tmp/result.md\n' + 'Exited with code 0',
      );
    });

    it('includes the continuation inline too when a non-zero exit leaves jobs still live', () => {
      // The mirror image: a non-zero exit returns control to the caller immediately even with siblings
      // still running, so — unlike the zero-exit case above — the inline branch must report them.
      expect(formatWaitTerminal(waitTerminalEvent, null, true, { exitCode: 1 })).toBe(
        'Job job-1 completed\n' +
          'Result path: /tmp/result.md\n' +
          'Workflow summary\n' +
          'Run coral-cli wait jobs job-2 to continue waiting.',
      );
    });

    it('formats an aborted outcome with the abort token in the header', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
          durationMs: 60_000,
          outcome: { kind: 'aborted' as const, reason: 'signal_abort' },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 aborted: signal_abort\n' +
          'Result path: /tmp/result.md\n' +
          'Run coral-cli wait jobs job-2 to continue waiting.',
      );
    });

    it('formats job_fault headers with the [kind] tag', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
          durationMs: 60_000,
          outcome: {
            kind: 'job_fault' as const,
            fault: {
              kind: 'wrapper_crashed' as const,
              cause: { message: 'provider timed out' },
            },
          },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 errored: Provider wrapper crashed: provider timed out. [wrapper_crashed]\n' +
          'Result path: /tmp/result.md\n' +
          'Run coral-cli wait jobs job-2 to continue waiting.',
      );
    });

    it('formats provider_exit with a note', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
          durationMs: 60_000,
          outcome: { kind: 'provider_exit' as const, code: 7, note: 'forced timeout at 600s' },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 provider exited 7: forced timeout at 600s\n' +
          'Result path: /tmp/result.md\n' +
          'Run coral-cli wait jobs job-2 to continue waiting.',
      );
    });

    it('omits the cursor from terminal continuation output when present', () => {
      expect(formatWaitTerminal(waitTerminalEvent, 'cursor-3', false)).toBe(
        'Job job-1 completed\n' +
          'Result path: /tmp/result.md\n' +
          'Run coral-cli wait jobs job-2 to continue waiting.',
      );
    });

    it('includes provider name literals when cause refs are rendered', () => {
      const providerSessionUnavailable = {
        ...waitTerminalEvent,
        result: {
          content: '',
          durationMs: 60_000,
          outcome: {
            kind: 'failed' as const,
            causeRef: {
              stream: {
                kind: 'session' as const,
                id: 'session-1',
              },
              seq: 4,
            },
          },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;
      const adapterOutputUnparseable = {
        ...waitTerminalEvent,
        result: {
          content: '',
          durationMs: 60_000,
          outcome: {
            kind: 'failed' as const,
            causeRef: {
              stream: {
                kind: 'session' as const,
                id: 'session-2',
              },
              seq: 7,
            },
          },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(
        formatWaitTerminal(providerSessionUnavailable, null, false, {
          describeCauseRef: () => 'Codex session unavailable: thread missing.',
        }),
      ).toContain('Job job-1 failed: Failed: Codex session unavailable: thread missing.');
      expect(
        formatWaitTerminal(adapterOutputUnparseable, null, false, {
          describeCauseRef: () => 'Claude produced unparseable output: bad json.',
        }),
      ).toContain('Job job-1 failed: Failed: Claude produced unparseable output: bad json.');
    });

    it('formats waiting output with pending jobs', () => {
      expect(formatWaitWaiting(waitWaitingEvent, 'cursor-4')).toBe(
        'Still waiting on 2 jobs. Run coral-cli wait jobs job-1 job-2 to continue waiting. (cursor: cursor-4)',
      );
    });

    it('formats waiting output with resume args without repeating job ids', () => {
      expect(formatWaitWaiting(waitWaitingEvent, 'cursor-4', ['job-1', 'job-2'])).toBe(
        'Still waiting on 2 jobs. Run coral-cli wait jobs job-1 job-2 to continue waiting. (cursor: cursor-4)',
      );
    });

    it('formats singular waiting output with resume args', () => {
      expect(formatWaitWaiting({ type: 'waiting', waitingJobIds: ['job-1'] }, null, ['job-1'])).toBe(
        'Still waiting on 1 job. Run coral-cli wait jobs job-1 to continue waiting.',
      );
    });

    it('formats waiting output without pending jobs', () => {
      expect(formatWaitWaiting({ type: 'waiting', waitingJobIds: [] }, null)).toBe('Still waiting; jobs: none.');
    });

    it('renders TTY wait lines with carriage return and padding', () => {
      expect(renderWaitLine('abc', { isTTY: true, columns: 5 })).toBe('\rabc  ');
    });

    it('renders non-TTY wait lines with a trailing newline', () => {
      expect(renderWaitLine('abc', { isTTY: false, columns: 5 })).toBe('abc\n');
    });

    it('defaults zero columns to 80 for TTY rendering', () => {
      const rendered = renderWaitLine('abc', { isTTY: true, columns: 0 });

      expect(rendered.startsWith('\rabc')).toBe(true);
      expect(rendered).toHaveLength(81);
    });
  });
});

describe('renderJobsList grouping', () => {
  const item = (jobId: string, cwd: string, jobKind: string): JobsListItem => ({
    jobId,
    phase: 'running',
    provider: jobKind === 'kb' ? 'kb' : 'codex',
    cwd,
    jobKind,
    workflowSlot: '-',
    age: '1m ago',
  });

  it('groups jobs into current project, then KB, then other projects by directory', () => {
    const rows = [
      item('cur-1', '/work/coral', 'provider'),
      item('kb-1', '/work/other', 'kb'),
      item('other-a', '/work/alpha', 'provider'),
      item('other-b', '/work/beta', 'provider'),
    ];

    const rendered = renderJobsList(rows, { cwd: '/work/coral' });

    expect(rendered).toContain('Current work directory (/work/coral)');
    expect(rendered).toContain('KB jobs (shared corpus)');
    expect(rendered).toContain('Other work directories');
    expect(rendered.indexOf('Current work directory')).toBeLessThan(rendered.indexOf('KB jobs'));
    expect(rendered.indexOf('KB jobs')).toBeLessThan(rendered.indexOf('Other work directories'));
    expect(rendered).toContain('kb-1');
    expect(rendered.indexOf('/work/alpha')).toBeLessThan(rendered.indexOf('/work/beta'));
  });

  it('renders a no-match message when there are no rows', () => {
    expect(renderJobsList([], { cwd: '/work/coral' })).toBe('No jobs match live phases');
  });
});
