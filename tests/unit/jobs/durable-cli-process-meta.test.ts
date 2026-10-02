import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import {
  decodeDurableCliContainmentStatus,
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
  it('refuses to encode a record missing the child root that keeps wrapper death from proving absence', () => {
    const { childRoot: _dropped, ...withoutChildRoot } = META;

    expect(() => encodeDurableCliProcessRuntimeMeta(withoutChildRoot as DurableCliProcessRuntimeMeta)).toThrow(
      /schema validation/u,
    );
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
