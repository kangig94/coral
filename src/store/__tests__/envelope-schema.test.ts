import { describe, expect, it } from 'vitest';

import { journalEventEnvelopeSchema } from '../envelope.js';

describe('journalEventEnvelopeSchema', () => {
  it('accepts a valid envelope with all supported fields', () => {
    const parsed = journalEventEnvelopeSchema.parse({
      seq: 42,
      ts: '2026-04-18T01:02:03.000Z',
      type: 'workflow.step.completed',
      stream: {
        kind: 'workflow',
        id: 'wf-123',
      },
      namespace: 'coordinator',
      project: '/tmp/project',
      correlationId: 'corr-123',
      causationSeq: 41,
      refs: {
        jobId: 'job-1',
        sessionId: 'session-1',
        parentJobId: 'job-0',
        workflowId: 'wf-123',
        workflowSlotId: 'slot-7',
        discussSessionId: 'discuss-1',
        kbRefs: [
          {
            entryId: 'kb-1',
            contentHash: 'abc123',
          },
        ],
      },
      bodyVersion: 2,
      body: {
        status: 'ok',
      },
    });

    expect(parsed).toEqual({
      seq: 42,
      ts: '2026-04-18T01:02:03.000Z',
      type: 'workflow.step.completed',
      stream: {
        kind: 'workflow',
        id: 'wf-123',
      },
      namespace: 'coordinator',
      project: '/tmp/project',
      correlationId: 'corr-123',
      causationSeq: 41,
      refs: {
        jobId: 'job-1',
        sessionId: 'session-1',
        parentJobId: 'job-0',
        workflowId: 'wf-123',
        workflowSlotId: 'slot-7',
        discussSessionId: 'discuss-1',
        kbRefs: [
          {
            entryId: 'kb-1',
            contentHash: 'abc123',
          },
        ],
      },
      bodyVersion: 2,
      body: {
        status: 'ok',
      },
    });
  });

  it('rejects missing bodyVersion', () => {
    const parsed = journalEventEnvelopeSchema.safeParse({
      seq: 1,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'job.created',
      stream: { kind: 'job', id: 'job-1' },
      body: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects bodyVersion = 0', () => {
    const parsed = journalEventEnvelopeSchema.safeParse({
      seq: 1,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'job.created',
      stream: { kind: 'job', id: 'job-1' },
      bodyVersion: 0,
      body: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects bodyVersion = -1', () => {
    const parsed = journalEventEnvelopeSchema.safeParse({
      seq: 1,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'job.created',
      stream: { kind: 'job', id: 'job-1' },
      bodyVersion: -1,
      body: {},
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects stream.kind = 'kb'", () => {
    const parsed = journalEventEnvelopeSchema.safeParse({
      seq: 1,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'job.created',
      stream: { kind: 'kb', id: 'job-1' },
      bodyVersion: 1,
      body: {},
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects stream.kind = 'unknown'", () => {
    const parsed = journalEventEnvelopeSchema.safeParse({
      seq: 1,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'job.created',
      stream: { kind: 'unknown', id: 'job-1' },
      bodyVersion: 1,
      body: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects seq = 0', () => {
    const parsed = journalEventEnvelopeSchema.safeParse({
      seq: 0,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'job.created',
      stream: { kind: 'job', id: 'job-1' },
      bodyVersion: 1,
      body: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects seq = -5', () => {
    const parsed = journalEventEnvelopeSchema.safeParse({
      seq: -5,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'job.created',
      stream: { kind: 'job', id: 'job-1' },
      bodyVersion: 1,
      body: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a minimal envelope with required fields and undefined optionals', () => {
    const parsed = journalEventEnvelopeSchema.parse({
      seq: 1,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'session.created',
      stream: {
        kind: 'session',
        id: 'session-1',
      },
      namespace: undefined,
      project: undefined,
      correlationId: undefined,
      causationSeq: undefined,
      refs: undefined,
      bodyVersion: 1,
      body: {
        ok: true,
      },
    });

    expect(parsed).toEqual({
      seq: 1,
      ts: '2026-04-18T00:00:00.000Z',
      type: 'session.created',
      stream: {
        kind: 'session',
        id: 'session-1',
      },
      namespace: undefined,
      project: undefined,
      correlationId: undefined,
      causationSeq: undefined,
      refs: undefined,
      bodyVersion: 1,
      body: {
        ok: true,
      },
    });
  });
});
