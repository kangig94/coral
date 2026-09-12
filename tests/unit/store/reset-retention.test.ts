import { describe, expect, it } from 'vitest';

import { parseStoreResetRetentionLedger } from '#src/store/reset-retention.js';

const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const HOLDER_ID = '323e4567-e89b-42d3-a456-426614174000';

function incident(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    incidentId: INCIDENT_ID,
    resetAt: '2026-09-13T00:00:00.000Z',
    evidenceBytes: 42,
    storedProductVersion: '0.9.16',
    preservation: { kind: 'linked' },
    resumeLeftActive: false,
    ...overrides,
  };
}

function ledger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    preserved: incident(),
    excess: null,
    discarded: null,
    ...overrides,
  };
}

function parse(value: unknown) {
  return parseStoreResetRetentionLedger(JSON.stringify(value));
}

describe('parseStoreResetRetentionLedger', () => {
  it.each([
    ['invalid JSON', '{'],
    ['non-object root', []],
    ['unknown version', ledger({ version: 2 })],
    ['missing preserved disposition', { version: 1, excess: null, discarded: null }],
    ['invalid incident id', ledger({ preserved: incident({ incidentId: 'not-an-id' }) })],
    ['invalid reset time', ledger({ preserved: incident({ resetAt: 4 }) })],
    ['negative evidence bytes', ledger({ preserved: incident({ evidenceBytes: -1 }) })],
    ['fractional evidence bytes', ledger({ preserved: incident({ evidenceBytes: 1.5 }) })],
    ['invalid resume marker', ledger({ preserved: incident({ resumeLeftActive: 'false' }) })],
    ['invalid stored version type', ledger({ preserved: incident({ storedProductVersion: 4 }) })],
    ['invalid preservation kind', ledger({ preserved: incident({ preservation: { kind: 'moved' } }) })],
    [
      'invalid copied coherence',
      ledger({
        preserved: incident({
          preservation: {
            kind: 'copied',
            cause: { kind: 'exclusion-unproven', reason: 'writer-live' },
            coherence: 'unknown',
          },
        }),
      }),
    ],
    [
      'invalid exclusion reason',
      ledger({
        preserved: incident({
          preservation: {
            kind: 'copied',
            cause: { kind: 'exclusion-unproven', reason: 'busy' },
            coherence: 'coherent',
          },
        }),
      }),
    ],
    [
      'invalid link errno',
      ledger({
        preserved: incident({
          preservation: {
            kind: 'copied',
            cause: { kind: 'link-unsupported', errno: 'ENOENT', code: 'ENOENT' },
            coherence: 'coherent',
          },
        }),
      }),
    ],
    ['invalid excess aggregate', ledger({ excess: { count: -1, evidenceBytes: 42, latest: {} } })],
    [
      'non-excess latest retention',
      ledger({ excess: { count: 1, evidenceBytes: 42, latest: { ...incident(), slot: 'claimed' } } }),
    ],
    [
      'invalid excess holder',
      ledger({
        excess: {
          count: 1,
          evidenceBytes: 42,
          latest: { ...incident(), slot: 'excess', holder: 'not-an-id', lineage: 'unrelated' },
        },
      }),
    ],
    ['invalid discarded aggregate', ledger({ discarded: { count: 1, evidenceBytes: -1, latest: {} } })],
    [
      'invalid discarded receipt',
      ledger({
        discarded: {
          count: 1,
          evidenceBytes: 42,
          latest: { resetAt: 'now', resetPolicyCause: 'unknown', evidenceBytes: 42, deferredTo: HOLDER_ID },
        },
      }),
    ],
  ])('rejects %s', (_label, value) => {
    const result = typeof value === 'string' ? parseStoreResetRetentionLedger(value) : parse(value);
    expect(result).toBeNull();
  });

  it('accepts additive unknown keys at every ledger level', () => {
    const value = ledger({
      futureRoot: true,
      preserved: incident({ futureIncident: true, preservation: { kind: 'linked', futureMechanism: true } }),
      excess: {
        count: 1,
        evidenceBytes: 42,
        futureAggregate: true,
        latest: {
          ...incident({ incidentId: '423e4567-e89b-42d3-a456-426614174000' }),
          slot: 'excess',
          holder: HOLDER_ID,
          lineage: 'undeterminable',
          futureRetention: true,
        },
      },
      discarded: {
        count: 1,
        evidenceBytes: 7,
        futureAggregate: true,
        latest: {
          resetAt: '2026-09-13T00:00:00.000Z',
          resetPolicyCause: 'older-incompatible',
          evidenceBytes: 7,
          deferredTo: HOLDER_ID,
          futureReceipt: true,
        },
      },
    });

    expect(parse(value)).toMatchObject({
      version: 1,
      preserved: { incidentId: INCIDENT_ID },
      excess: { count: 1, latest: { holder: HOLDER_ID, lineage: 'undeterminable' } },
      discarded: { count: 1, latest: { deferredTo: HOLDER_ID } },
    });
  });

  it('preserves the distinction between unattempted and timed-out writer exclusion', () => {
    const parsed = parse(
      ledger({
        preserved: incident({
          preservation: {
            kind: 'copied',
            cause: { kind: 'exclusion-unproven', reason: 'not-attempted' },
            coherence: 'coherent',
          },
        }),
      }),
    );

    expect(parsed?.preserved?.preservation).toEqual({
      kind: 'copied',
      cause: { kind: 'exclusion-unproven', reason: 'not-attempted' },
      coherence: 'coherent',
    });
  });
});
