import { describe, expect, it } from 'vitest';

import { causeRefSchema } from '#src/causality/cause-ref.js';
import { journalEventEnvelopeSchema, journalEventRefsSchema } from '#src/store/envelope.js';

// Historical causes and nullable stored status fields belong to the independent durable contracts.
describe('live job stream boundaries', () => {
  it('admits only the three live Journal domains', () => {
    expect(journalEventEnvelopeSchema.shape.stream.shape.kind.options).toEqual(['job', 'discuss', 'workflow']);
    expect(causeRefSchema.shape.stream.shape.kind.options).toEqual(['job', 'discuss', 'workflow']);
    expect(causeRefSchema.safeParse({ stream: { kind: 'session', id: 'old' }, seq: 1 }).success).toBe(false);
    expect(journalEventRefsSchema.safeParse({ jobId: 'job', sessionId: 'old' }).success).toBe(false);
  });
});
