import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import {
  decodeDurableCliContainmentStatus,
  decodeDurableCliProcessRuntimeMeta,
  durableCliProcessRuntimeMetaKey,
  encodeDurableCliContainmentStatus,
  encodeDurableCliProcessRuntimeMeta,
  type DurableCliContainmentStatus,
  type DurableCliProcessRuntimeEvidence,
  type DurableCliProcessRuntimeMeta,
} from '#src/jobs/runtime-meta.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const META: DurableCliProcessRuntimeMeta = {
  jobId: JOB_ID,
  pid: 4242,
  incarnation: testIncarnation(1_000),
  processGroupId: 4242,
  childRoot: { pid: 4243, incarnation: testIncarnation(1_001) },
};

describe('durable CLI process runtime meta', () => {
  it('keys on the job alone, since a durable CLI has no operation to key on', () => {
    expect(durableCliProcessRuntimeMetaKey(JOB_ID)).toBe(`durable_cli_process.v2:${JOB_ID}`);
  });

  it('names a row for a non-canonical job id instead of throwing at readers and pruners', () => {
    // Building a key is naming a row, not validating one. Every write goes through the strict schema, so a
    // non-canonical id can never have produced a row — the key it names is simply one that does not exist,
    // which is exactly what a read and a delete need it to be.
    expect(durableCliProcessRuntimeMetaKey('not-a-uuid')).toBe('durable_cli_process.v2:not-a-uuid');
    expect(() => encodeDurableCliProcessRuntimeMeta({ ...META, jobId: 'not-a-uuid' })).toThrow();
  });

  it('round-trips the recorded identity', () => {
    expect(decodeDurableCliProcessRuntimeMeta(encodeDurableCliProcessRuntimeMeta(META))).toEqual(META);
  });

  it('refuses to encode a record missing the child root that keeps wrapper death from proving absence', () => {
    const { childRoot: _dropped, ...withoutChildRoot } = META;

    expect(() => encodeDurableCliProcessRuntimeMeta(withoutChildRoot as DurableCliProcessRuntimeMeta)).toThrow(
      /schema validation/u,
    );
  });

  it.each([
    ['no row at all', null],
    ['an absent value', undefined],
    ['bytes that are not JSON', '{'],
    ['JSON of another shape', JSON.stringify({ jobId: JOB_ID, pid: META.pid })],
    ['the old payload generation', JSON.stringify({ jobId: JOB_ID, pid: META.pid, incarnation: META.incarnation })],
  ])('decodes %s as no recorded identity rather than throwing', (_label, raw) => {
    // Every one of these means the same thing to the only caller that asks — there is nothing to check the
    // process against, so observation must answer `unknown`. Throwing would push that decision into a
    // `catch` at each call site and invite one of them to guess `absent` instead.
    expect(decodeDurableCliProcessRuntimeMeta(raw)).toBeNull();
  });
});

describe('durable CLI containment status', () => {
  const evidenceVariants: readonly DurableCliProcessRuntimeEvidence[] = [
    { kind: 'current', record: META },
    {
      kind: 'predecessor',
      record: { version: 1, jobId: JOB_ID, pid: META.pid, incarnation: META.incarnation },
    },
    { kind: 'unavailable', reason: 'corrupt-current' },
  ];
  const dispositionVariants: readonly DurableCliContainmentStatus['disposition'][] = [
    { kind: 'held', reason: 'waiting for process absence', retryIntervalMs: 1_000, abandonment: 'abort-job' },
    { kind: 'operator-abandoned', processAbsenceProven: false },
  ];

  it('round-trips every evidence and disposition variant', () => {
    for (const evidence of evidenceVariants) {
      for (const disposition of dispositionVariants) {
        const status = { jobId: JOB_ID, evidence, disposition };

        expect(decodeDurableCliContainmentStatus(encodeDurableCliContainmentStatus(status))).toEqual(status);
      }
    }
  });

  it('round-trips an oversized hold with visibly truncated evidence', () => {
    const reason = '\u0000😀'.repeat(4_096);
    const status: DurableCliContainmentStatus = {
      jobId: JOB_ID,
      evidence: evidenceVariants[0],
      disposition: { kind: 'held', reason, retryIntervalMs: 1_000, abandonment: 'abort-job' },
    };

    const decoded = decodeDurableCliContainmentStatus(encodeDurableCliContainmentStatus(status));

    expect(decoded).not.toBeNull();
    expect(decoded?.disposition.kind).toBe('held');
    if (decoded?.disposition.kind !== 'held') return;
    expect(decoded.disposition.reason).not.toBe(reason);
    expect(decoded.disposition.reason).toMatch(/ \[truncated\]$/u);
    expect(reason.startsWith(decoded.disposition.reason.replace(/ \[truncated\]$/u, ''))).toBe(true);
  });
});
