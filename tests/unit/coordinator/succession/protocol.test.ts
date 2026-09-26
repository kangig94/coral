import { describe, expect, it } from 'vitest';

import { successionPreparationSchema } from '#src/coordinator/succession/protocol.js';
import { SUCCESSION_PROTOCOL_VERSION } from '#src/infra/succession-address.js';

describe('succession preparation record', () => {
  it('should read a preparation a newer build extended at every nesting level', () => {
    const parsed = successionPreparationSchema.safeParse({
      version: SUCCESSION_PROTOCOL_VERSION,
      requestId: 'request-1',
      attemptId: 'attempt-1',
      incumbentInstanceId: 'incumbent',
      incumbentPid: 4242,
      incumbentKey: 'incumbent-key',
      targetKey: 'target-key',
      capabilitiesKey: 'capabilities-key',
      epochKey: 'lineage:7',
      admissionRevision: 1,
      accepts: [{ owner: 'durable-cli', generation: 1, laterField: true }],
      receipts: [
        {
          owner: 'durable-cli',
          generation: 1,
          attemptId: 'attempt-1',
          receiptId: 'receipt-1',
          recoveryGrantId: 'grant-1',
          payload: {},
          laterField: true,
        },
      ],
      stage: 'ready',
      ready: {
        attemptId: 'attempt-1',
        successorPid: 4343,
        targetKey: 'target-key',
        epochKey: 'lineage:7',
        admissionRevision: 1,
        receiptIds: ['receipt-1'],
        laterField: true,
      },
      laterField: true,
    });

    expect(parsed.success).toBe(true);
  });
});
