import { describe, expect, it } from 'vitest';

import { advanceWaitRenderCursor, MAX_WAIT_JOB_IDS, parseWaitStreamEvent } from '#src/jobs/wait-stream-event.js';
import { formatWaitCarrierInterrupted, formatWaitWaiting } from '#src/cli/format/wait.js';
import type { CarrierInterruptedWaitEvent } from '#src/jobs/wait.js';

const TIMING = { origin: 'runtime', originAt: 't0', emittedAt: 't1', elapsedMs: 0 } as const;

const INTERRUPTED: CarrierInterruptedWaitEvent = {
  type: 'interrupted',
  jobId: 'job-1',
  storedPhase: 'running',
  observedMaxJournalSeq: 12,
  remainingJobIds: ['job-1', 'job-2'],
  observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
  continuity: 'unavailable',
  outcome: 'unknown',
};

describe('carrier interrupted wait event', () => {
  it('round-trips under its own event name', () => {
    expect(parseWaitStreamEvent('interrupted', JSON.stringify(INTERRUPTED))).toEqual(INTERRUPTED);
  });

  it.each([
    ['a journal sequence', { seq: 4 }],
    ['a result path', { resultPath: '/tmp/result.md' }],
    ['a continuity snapshot', { continuity: null }],
  ])('refuses to carry %s', (_label, extra) => {
    // The variant is strict so that a producer cannot smuggle terminal content through the one event that
    // must never end a job. Failing to parse is the point: a consumer never gets the chance to honour it.
    expect(() => parseWaitStreamEvent('interrupted', JSON.stringify({ ...INTERRUPTED, ...extra }))).toThrow();
  });

  it('never advances the render cursor', () => {
    const decision = advanceWaitRenderCursor({ afterSeq: 3 }, INTERRUPTED);

    // `observedMaxJournalSeq` is what was seen, not what was consumed. Advancing the resume cursor past it
    // would let a reconnect skip journal events this stream never delivered.
    expect(decision.cursor).toEqual({ afterSeq: 3 });
    expect(decision.shouldRender).toBe(true);
  });

  it('renders as an observation that keeps waiting, not as an outcome', () => {
    const line = formatWaitCarrierInterrupted(INTERRUPTED);

    expect(line).toContain('carrier is no longer present');
    expect(line).toContain('still waiting for a durable result');
    expect(line).not.toMatch(/failed|aborted|completed/u);
    // No continuation line. Every other event that prints one does so where this process is about to hand
    // control back, so "run this to continue waiting" names a real next step. This event hands control to
    // nobody — the subscription stays open — so the same line would tell a caller to open a second
    // subscription to the stream it is already reading.
    expect(line).not.toContain('coral-cli wait jobs');
  });
});

describe('forward-compatible variants tolerate an additive field', () => {
  // A newer coordinator adding one optional field to any variant but `interrupted` must not make an
  // older build's `.parse` throw mid-stream — passthrough is what lets the event still decode.
  it.each([
    ['progress', { type: 'progress', jobId: 'job-1', seq: 1, message: 'working', timing: TIMING, newField: true }],
    [
      'queued',
      {
        type: 'queued',
        jobId: 'job-1',
        queuePosition: 1,
        runningJobIds: [],
        timing: TIMING,
        jobKind: 'provider',
        sessionId: 'session-1',
        newField: true,
      },
    ],
    [
      'terminal',
      {
        type: 'terminal',
        jobId: 'job-1',
        seq: 1,
        remainingJobIds: [],
        resultPath: '/tmp/result.md',
        result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 12 },
        newField: true,
      },
    ],
    ['waiting', { type: 'waiting', waitingJobIds: ['job-1'], newField: true }],
  ])('parses a %s event carrying an unrecognized field', (eventType, payload) => {
    expect(() => parseWaitStreamEvent(eventType, JSON.stringify(payload))).not.toThrow();
  });

  it('still refuses an additive field on interrupted — the one variant kept strict', () => {
    expect(() => parseWaitStreamEvent('interrupted', JSON.stringify({ ...INTERRUPTED, newField: true }))).toThrow();
  });
});

describe('waiting snapshot carrierUnknownJobIds', () => {
  it('parses a waiting snapshot that reports unconfirmed carriers', () => {
    const waiting = { type: 'waiting', waitingJobIds: ['job-1', 'job-2'], carrierUnknownJobIds: ['job-2'] };

    expect(parseWaitStreamEvent('waiting', JSON.stringify(waiting))).toEqual(waiting);
    expect(formatWaitWaiting(waiting as never, null)).toContain('Carrier unconfirmed for: job-2.');
  });

  it('rejects an empty list instead of accepting a field that says nothing', () => {
    // Omitted means "no unknowns"; present-but-empty would be a third encoding of the same fact, and the
    // one a renderer cannot distinguish from a build that does not report unknowns at all.
    expect(() =>
      parseWaitStreamEvent('waiting', JSON.stringify({ type: 'waiting', waitingJobIds: [], carrierUnknownJobIds: [] })),
    ).toThrow();
  });

  it('says nothing about carriers when the field is absent', () => {
    expect(formatWaitWaiting({ type: 'waiting', waitingJobIds: ['job-1'] }, null)).not.toContain('Carrier');
  });
});

describe('MAX_WAIT_JOB_IDS bounds every response job-id array', () => {
  // One past the cap: the request side already bounds a caller to at most `MAX_WAIT_JOB_IDS` jobs, so a
  // response naming more than that names more jobs than any one wait request could have named.
  const overCap = Array.from({ length: MAX_WAIT_JOB_IDS + 1 }, (_unused, index) => `job-${index}`);

  it('rejects an over-cap runningJobIds on a queued event', () => {
    const queued = {
      type: 'queued',
      jobId: 'job-1',
      queuePosition: 1,
      runningJobIds: overCap,
      timing: { origin: 'queued', originAt: 't0', emittedAt: 't1', elapsedMs: 0 },
      jobKind: 'provider',
      sessionId: 'session-1',
    };

    expect(() => parseWaitStreamEvent('queued', JSON.stringify(queued))).toThrow();
  });

  it('rejects an over-cap remainingJobIds on a terminal event', () => {
    const terminal = {
      type: 'terminal',
      jobId: 'job-1',
      seq: 1,
      remainingJobIds: overCap,
      resultPath: '/tmp/result.md',
      result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 12 },
    };

    expect(() => parseWaitStreamEvent('terminal', JSON.stringify(terminal))).toThrow();
  });

  it('rejects an over-cap remainingJobIds on an interrupted event', () => {
    expect(() =>
      parseWaitStreamEvent('interrupted', JSON.stringify({ ...INTERRUPTED, remainingJobIds: overCap })),
    ).toThrow();
  });

  it('rejects an over-cap waitingJobIds on a waiting event', () => {
    expect(() =>
      parseWaitStreamEvent('waiting', JSON.stringify({ type: 'waiting', waitingJobIds: overCap })),
    ).toThrow();
  });

  it('rejects an over-cap carrierUnknownJobIds on a waiting event', () => {
    expect(() =>
      parseWaitStreamEvent(
        'waiting',
        JSON.stringify({ type: 'waiting', waitingJobIds: ['job-1'], carrierUnknownJobIds: overCap }),
      ),
    ).toThrow();
  });
});
