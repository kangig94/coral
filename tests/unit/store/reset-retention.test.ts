import { describe, expect, it } from 'vitest';

import { parseStoreResetParkedRecord, parseStoreResetRetentionLedger } from '#src/store/reset-retention.js';

const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const HOLDER_ID = '323e4567-e89b-42d3-a456-426614174000';

function incident(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    incidentId: INCIDENT_ID,
    resetAt: '2026-09-13T00:00:00.000Z',
    evidenceBytes: 42,
    storedProductVersion: '0.9.16',
    preservation: { kind: 'linked', coherence: 'coherent' },
    resumeLeftActive: false,
    ...overrides,
  };
}

function ledger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    pending: null,
    preserved: incident(),
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
    ['missing preserved disposition', { version: 1, pending: null }],
    ['invalid incident id', ledger({ preserved: incident({ incidentId: 'not-an-id' }) })],
    ['invalid reset time', ledger({ preserved: incident({ resetAt: 4 }) })],
    ['negative evidence bytes', ledger({ preserved: incident({ evidenceBytes: -1 }) })],
    ['fractional evidence bytes', ledger({ preserved: incident({ evidenceBytes: 1.5 }) })],
    ['invalid resume marker', ledger({ preserved: incident({ resumeLeftActive: 'false' }) })],
    ['invalid stored version type', ledger({ preserved: incident({ storedProductVersion: 4 }) })],
    ['invalid stored version text', ledger({ preserved: incident({ storedProductVersion: 'bad\nrow' }) })],
    [
      'invalid pending identity',
      ledger({
        pending: {
          resetAt: '2026-09-13T00:00:00.000Z',
          identities: [{ name: 'store.db', dev: '-1', ino: '2' }],
          outcome: { kind: 'preserve', incident: incident() },
        },
      }),
    ],
    [
      'duplicate pending identity',
      ledger({
        pending: {
          resetAt: '2026-09-13T00:00:00.000Z',
          identities: [
            { name: 'store.db', dev: '1', ino: '2' },
            { name: 'store.db', dev: '1', ino: '3' },
          ],
          outcome: { kind: 'preserve', incident: incident() },
        },
      }),
    ],
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
  ])('rejects %s', (_label, value) => {
    const result = typeof value === 'string' ? parseStoreResetRetentionLedger(value) : parse(value);
    expect(result).toBeNull();
  });

  it('accepts additive unknown keys at every ledger level', () => {
    const value = ledger({
      futureRoot: true,
      preserved: incident({
        futureIncident: true,
        preservation: { kind: 'linked', coherence: 'coherent', futureMechanism: true },
      }),
    });

    expect(parse(value)).toMatchObject({
      version: 1,
      preserved: { incidentId: INCIDENT_ID },
    });
  });

  it('rejects the obsolete unattempted and unproven Revision 2 vocabulary', () => {
    const parsed = parse(
      ledger({
        preserved: incident({
          preservation: {
            kind: 'copied',
            cause: { kind: 'exclusion-unproven', reason: 'not-attempted' },
            coherence: 'unproven',
          },
        }),
      }),
    );

    expect(parsed).toBeNull();
  });

  it('accepts a pending promise without retaining obsolete parking fields', () => {
    const pendingIncident = incident({ incidentId: HOLDER_ID });
    const parsed = parse(
      ledger({
        preserved: null,
        pending: {
          resetAt: '2026-09-13T00:00:00.000Z',
          parkingId: HOLDER_ID,
          parked: ['store.db-wal'],
          identities: [{ name: 'store.db', dev: '1', ino: '2' }],
          outcome: { kind: 'preserve', incident: pendingIncident },
        },
      }),
    );

    expect(parsed).toMatchObject({
      pending: { outcome: { kind: 'preserve', incident: { incidentId: HOLDER_ID } } },
      preserved: null,
    });
    expect(parsed?.pending).not.toHaveProperty('parkingId');
    expect(parsed?.pending).not.toHaveProperty('parked');
  });

  it('normalizes a valid stored product version at ledger ingress', () => {
    expect(parse(ledger({ preserved: incident({ storedProductVersion: 'v0.9.16' }) }))?.preserved).toMatchObject({
      storedProductVersion: '0.9.16',
    });
  });
});

describe('parseStoreResetParkedRecord', () => {
  function parkedRecord(transaction: unknown): Record<string, unknown> {
    const kind =
      typeof transaction === 'object' && transaction !== null && 'kind' in transaction ? transaction.kind : null;
    return {
      version: 1,
      parkingId: INCIDENT_ID,
      parkedAt: '2026-09-13T00:00:00.000Z',
      phase: 'in-flight',
      cause: kind === 'claim' ? 'residual' : 'publication',
      incidentId: kind === 'publication' ? INCIDENT_ID : null,
      names: [],
      entries: [],
      transaction,
      classification: 'corrupt-or-unsupported',
    };
  }

  it.each([
    { kind: 'publication', incidentId: INCIDENT_ID, identities: [{ name: 'store.db', dev: '1', ino: '2' }] },
    { kind: 'claim', names: ['store.db', 'store.db-wal'] },
  ])('accepts the $kind in-flight transaction variant', (transaction) => {
    expect(parseStoreResetParkedRecord(JSON.stringify(parkedRecord(transaction)))?.transaction).toEqual(transaction);
  });

  it('accepts terminal entries that describe the parked object kinds', () => {
    const value = {
      ...parkedRecord(null),
      phase: 'terminal',
      cause: 'intruder',
      names: ['store.db', 'store.db-wal'],
      entries: [
        { name: 'store.db', kind: 'directory', sizeBytes: 0 },
        { name: 'store.db-wal', kind: 'symbolic-link', sizeBytes: 12 },
      ],
    };

    expect(parseStoreResetParkedRecord(JSON.stringify(value))?.entries).toEqual(value.entries);
  });

  it.each([
    ['in-flight without a transaction', parkedRecord(null)],
    ['terminal with a transaction', { ...parkedRecord({ kind: 'claim', names: ['store.db'] }), phase: 'terminal' }],
    [
      'terminal names that disagree with entries',
      {
        ...parkedRecord(null),
        phase: 'terminal',
        names: ['store.db'],
        entries: [{ name: 'store.db-wal', kind: 'regular-file', sizeBytes: 1 }],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseStoreResetParkedRecord(JSON.stringify(value))).toBeNull();
  });
});
