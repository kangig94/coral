import { describe, expect, it } from 'vitest';

import { BackendToolHttpError } from '#src/transport/http/errors.js';
import type { BackendStatusFull } from '#src/transport/http/backend/status.js';
import type { ShutdownResult } from '#src/transport/http/backend/shutdown.js';
import type { AcceptedLaunchResponse } from '#src/transport/http/client.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '#src/discuss/session-types.js';
import type { WatchState } from '#src/discuss/watch.js';
import type { KbReadResult } from '#src/kb/entry-types.js';
import type { AbortResult } from '#src/jobs/contracts/abort-registry.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
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
import { formatError, formatErrorEnvelope } from '#src/cli/format/error.js';
import { formatAbortResult, formatLaunch } from '#src/cli/format/jobs.js';
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

const runningDecision = {
  launchState: 'running',
  job: 'job-1',
  session: 'session-1',
} satisfies AcceptedLaunchResponse;

const queuedDecision = {
  launchState: 'queued',
  job: 'job-2',
  session: 'session-2',
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

const waitProgressEvent = {
  type: 'progress',
  jobId: 'job-1',
  seq: 4,
  message: 'Still running',
} satisfies Extract<WaitStreamEvent, { type: 'progress' }>;

const waitQueuedEvent = {
  type: 'queued',
  jobId: 'job-1',
  sessionId: 'session-1',
  queuePosition: 2,
  runningJobIds: ['job-9'],
} satisfies Extract<WaitStreamEvent, { type: 'queued' }>;

const waitTerminalEvent = {
  type: 'terminal',
  jobId: 'job-1',
  seq: 5,
  remainingJobIds: ['job-2'],
  resultPath: '/tmp/result.md',
  result: {
    content: 'Workflow summary',
    outcome: { kind: 'completed' as const },
  },
} satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

const waitWaitingEvent = {
  type: 'waiting',
  waitingJobIds: ['job-1', 'job-2'],
} satisfies Extract<WaitStreamEvent, { type: 'waiting' }>;

describe('cli format', () => {
  describe('formatLaunch', () => {
    it('formats a running decision', () => {
      expect(formatLaunch(runningDecision)).toBe('Job job-1 running (session session-1)');
    });

    it('formats a queued decision', () => {
      expect(formatLaunch(queuedDecision)).toBe('Job job-2 queued (session session-2)');
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

      expect(
        formatDiscussWatch(result),
      ).toBe(
        'Session session-1 [bidding]\n' + 'Topic: Risk tradeoffs\n' + 'Epoch: 2 | Step: 3 | Events: 2 | Cursor: 9',
      );
    });

    it('falls back to a generic formatter for invalid watch input', () => {
      expect(formatDiscussWatch({ invalid: true })).toBe('{"invalid":true}');
    });
  });

  describe('backend formatters', () => {
    it('formats an ok backend status', () => {
      const status = {
        status: 'ok',
        health: {
          status: 'ok',
          version: '1.2.3',
          bundleHash: 'bundle-hash',
          instanceId: 'instance-1',
          uptimeMs: 1234,
          active: 2,
          activeJobs: 1,
          inflightRequests: 0,
        },
      } satisfies BackendStatusFull;

      expect(formatBackendStatus(status)).toBe(
        'Backend ok\n' + 'Version: 1.2.3\n' + 'Uptime: 1234ms\n' + 'Active: 2\n' + 'Active jobs: 1',
      );
    });

    it('formats a not-running backend status', () => {
      expect(formatBackendStatus({ status: 'not_running' })).toBe('Backend not running');
    });

    it('formats a shutting-down backend status', () => {
      expect(formatBackendStatus({ status: 'shutting_down' })).toBe('Backend shutting down');
    });

    it('formats an unauthorized backend status', () => {
      expect(formatBackendStatus({ status: 'unauthorized' })).toBe('Backend unauthorized');
    });

    it('formats a successful shutdown result', () => {
      const result = { ok: true } satisfies ShutdownResult;
      expect(formatShutdown(result)).toBe('Backend shutdown initiated');
    });

    it('formats a failed shutdown result', () => {
      const result = { ok: false, reason: 'unauthorized' } satisfies ShutdownResult;
      expect(formatShutdown(result)).toBe('Shutdown failed: unauthorized');
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
            },
          ],
          mode: 'hybrid',
          warning: 'Enhanced KB index is stale; run kb_reindex to refresh it.',
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
      const parsed = JSON.parse(formatKbSearch({ results: [], mode: 'text' }));
      expect(parsed.count).toBe(0);
    });

    it('formats vector kb search results with a vector indicator and warning codes', () => {
      const parsed = JSON.parse(
        formatKbSearch({
          results: [],
          mode: 'vector',
          warnings: ['kb_search_degraded_until_coordinator_rebuild'],
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

    it('formats kb promote, update, and delete results', () => {
      expect(formatKbPromote({ path: '/tmp/kb/notes/cli-kb-tooling.md' })).toBe(
        'Created: /tmp/kb/notes/cli-kb-tooling.md',
      );
      expect(formatKbUpdate({ path: '/tmp/kb/notes/cli-kb-tooling.md' })).toBe(
        'Updated: /tmp/kb/notes/cli-kb-tooling.md',
      );
      expect(formatKbDelete({ deleted: '/tmp/kb/notes/cli-kb-tooling.md' })).toBe(
        'Deleted: /tmp/kb/notes/cli-kb-tooling.md',
      );
    });

    it('formats kb reindex as one-liner and rewrites kb_reindex warnings', () => {
      const formatted = formatKbReindex(
        {
          notes: 4,
          sources: 0,
          communities: 0,
          principles: 2,
          tags: 3,
          duration_ms: 25,
          mode: 'text',
          warning: 'Run kb_reindex again to refresh the enhanced index.',
        },
        'node "/tmp/coral-cli.cjs"',
      );

      expect(formatted).toBe(
        'Reindexed: 4 notes, 0 communities, 2 principles, 3 tags (25ms, text)\n' +
          'Warning: Run node "/tmp/coral-cli.cjs" kb reindex again to refresh the enhanced index.',
      );
    });
  });

  describe('formatError', () => {
    it('formats a BackendToolHttpError-shaped value', () => {
      expect(
        formatError({
          statusCode: 403,
          body: { code: 'scope_mismatch', message: 'Scope mismatch' },
          message: 'Backend request failed: 403 Forbidden',
        }),
      ).toBe('HTTP 403: {"code":"scope_mismatch","message":"Scope mismatch"}');
    });

    it('formats an Error instance', () => {
      expect(formatError(new Error('boom'))).toBe('boom');
    });

    it('formats plain objects with message property', () => {
      expect(formatError({ message: 'KB note already exists: /path/to/note.md' })).toBe(
        'KB note already exists: /path/to/note.md',
      );
    });

    it('formats unknown string values', () => {
      expect(formatError('plain failure')).toBe('plain failure');
    });
  });

  describe('formatErrorEnvelope', () => {
    it('formats UsageError envelopes on a single line', () => {
      const { envelope } = buildErrorEnvelope(new UsageError('input is required (-i, --input)'));

      expect(formatErrorEnvelope(envelope)).toBe('input is required (-i, --input) [code=invalid_usage]');
    });

    it('formats BackendToolHttpError envelopes with detail on a second line', () => {
      const error = new BackendToolHttpError('HTTP 503', 503, {
        code: 'backend_recovering',
        message: 'recovering — retry after 500ms',
        remediation: 'Retry after the backend finishes recovery.',
        detail: { retryAfterMs: 500 },
      });
      const { envelope } = buildErrorEnvelope(error);

      expect(formatErrorEnvelope(envelope, error.statusCode)).toBe(
        'recovering — retry after 500ms [code=backend_recovering, http=503]\n' +
          'remediation: Retry after the backend finishes recovery.\n' +
          'Detail: {"retryAfterMs":500}',
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

    it('formats BackendToolHttpError detail: null literally', () => {
      const error = new BackendToolHttpError('HTTP 400', 400, {
        code: 'bad_request',
        message: 'Missing prompt',
        detail: null,
      });
      const { envelope } = buildErrorEnvelope(error);

      expect(formatErrorEnvelope(envelope, error.statusCode)).toBe(
        'Missing prompt [code=bad_request, http=400]\nDetail: null',
      );
    });

    it('does not normalize multi-line envelope heads and keeps Detail: on the next line boundary', () => {
      const formatted = formatErrorEnvelope(
        {
          error: true,
          code: 'bad_request',
          message: 'line one\nline two',
          detail: { field: 'prompt' },
        },
        400,
      );

      expect(formatted.split('\n')).toEqual([
        'line one',
        'line two [code=bad_request, http=400]',
        'Detail: {"field":"prompt"}',
      ]);
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
        expectedText: 'HTTP 403: {"code":"scope_mismatch","message":"Scope mismatch"}',
        expectedEnvelope: 'Scope mismatch [code=scope_mismatch, http=403]',
      },
      {
        label: 'plain Error instance',
        error: new Error('boom'),
        expectedText: 'boom',
        expectedEnvelope: 'boom [code=internal]',
      },
    ])('documents formatError/formatErrorEnvelope parity for $label', ({ error, expectedText, expectedEnvelope }) => {
      const { envelope } =
        error instanceof Error
          ? buildErrorEnvelope(error)
          : buildErrorEnvelope(new BackendToolHttpError(error.message, error.statusCode, error.body));
      const statusCode = error instanceof Error ? undefined : error.statusCode;

      expect(formatError(error)).toBe(expectedText);
      expect(formatErrorEnvelope(envelope, statusCode)).toBe(expectedEnvelope);
    });
  });

  describe('wait formatters', () => {
    it('formats progress events without a prefix when no label is passed (single-job case)', () => {
      expect(formatWaitProgress(waitProgressEvent)).toBe('Still running');
    });

    it('formats queued events without a prefix when no label is passed (single-job case)', () => {
      expect(formatWaitQueued(waitQueuedEvent)).toBe('queued at position 2');
    });

    it('prefixes queued events with the caller-supplied positional label (multi-job case)', () => {
      expect(formatWaitQueued(waitQueuedEvent, 'j1')).toBe('j1 - queued at position 2');
    });

    it('injects the positional label after the leading time bracket on progress messages', () => {
      const withTime = { ...waitProgressEvent, message: '[ 0m  2s] 0-arc Thread ready' };
      expect(formatWaitProgress(withTime, 'j0')).toBe('[ 0m  2s] j0 - 0-arc Thread ready');
    });

    it('falls back to a leading "label - " prefix on progress messages without a time bracket', () => {
      expect(formatWaitProgress(waitProgressEvent, 'j0')).toBe('j0 - Still running');
    });

    it('keeps full jobId on terminal events without surrounding brackets', () => {
      const longId = '3ee5b730-31b3-46ed-8efe-0127b24e2cfa';
      expect(formatWaitTerminal({ ...waitTerminalEvent, jobId: longId }, null, false)).toContain(
        `Job ${longId} completed`,
      );
    });

    it('formats a non-inline terminal event with the result path and lists remaining jobIds', () => {
      expect(formatWaitTerminal(waitTerminalEvent, null, false)).toBe(
        'Job job-1 completed\n' + 'Result path: /tmp/result.md\n' + 'Remaining jobs: job-2',
      );
    });

    it('reports "none" when no jobs remain on a non-inline terminal event', () => {
      const event = { ...waitTerminalEvent, remainingJobIds: [] };
      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 completed\n' + 'Result path: /tmp/result.md\n' + 'Remaining jobs: none',
      );
    });

    it('joins multiple remaining jobIds with commas on a non-inline terminal event', () => {
      const event = { ...waitTerminalEvent, remainingJobIds: ['job-a', 'job-b', 'job-c'] };
      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 completed\n' + 'Result path: /tmp/result.md\n' + 'Remaining jobs: job-a, job-b, job-c',
      );
    });

    it('formats an inline terminal event with a content preview', () => {
      expect(formatWaitTerminal(waitTerminalEvent, null, true)).toBe(
        'Job job-1 completed\n' + 'Result path: /tmp/result.md\n' + 'Workflow summary',
      );
    });

    it('formats provider_exit with a zero code', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
          outcome: { kind: 'provider_exit' as const, code: 0 },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(formatWaitTerminal(event, null, true)).toBe(
        'Job job-1 provider exited 0\n' + 'Result path: /tmp/result.md\n' + 'Exited with code 0',
      );
    });

    it('formats an aborted outcome with the abort token in the header', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
          outcome: { kind: 'aborted' as const, reason: 'signal_abort' },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 aborted: signal_abort\n' + 'Result path: /tmp/result.md\n' + 'Remaining jobs: job-2',
      );
    });

    it('formats job_fault headers with the [kind] tag', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
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
        'Job job-1 errored: Provider wrapper crashed: provider timed out. [wrapper_crashed]\n'
          + 'Result path: /tmp/result.md\n'
          + 'Remaining jobs: job-2',
      );
    });

    it('formats provider_exit with a note', () => {
      const event = {
        ...waitTerminalEvent,
        result: {
          content: '',
          outcome: { kind: 'provider_exit' as const, code: 7, note: 'forced timeout at 600s' },
        },
      } satisfies Extract<WaitStreamEvent, { type: 'terminal' }>;

      expect(formatWaitTerminal(event, null, false)).toBe(
        'Job job-1 provider exited 7: forced timeout at 600s\n'
          + 'Result path: /tmp/result.md\n'
          + 'Remaining jobs: job-2',
      );
    });

    it('includes the cursor in terminal output when present', () => {
      expect(formatWaitTerminal(waitTerminalEvent, 'cursor-3', false)).toBe(
        'Job job-1 completed\n' + 'Result path: /tmp/result.md\n' + 'Remaining jobs: job-2\n' + 'Cursor: cursor-3',
      );
    });

    it('includes provider name literals when cause refs are rendered', () => {
      const providerSessionUnavailable = {
        ...waitTerminalEvent,
        result: {
          content: '',
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
      ).toContain(
        'Job job-1 failed: Failed: Codex session unavailable: thread missing.',
      );
      expect(
        formatWaitTerminal(adapterOutputUnparseable, null, false, {
          describeCauseRef: () => 'Claude produced unparseable output: bad json.',
        }),
      ).toContain(
        'Job job-1 failed: Failed: Claude produced unparseable output: bad json.',
      );
    });

    it('formats waiting output with pending jobs', () => {
      expect(formatWaitWaiting(waitWaitingEvent, 'cursor-4')).toBe(
        'Still waiting; jobs: job-1, job-2 (cursor: cursor-4)',
      );
    });

    it('formats waiting output without pending jobs', () => {
      expect(formatWaitWaiting({ type: 'waiting', waitingJobIds: [] }, null)).toBe(
        'Still waiting; jobs: none',
      );
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
