import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RecoveryContainment,
  defineRecoverySource,
  type RecoveryPolicy,
  type RecoveryQuarantineWrite,
  type RecoverySubject,
} from '#src/recovery/containment.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

type QuarantineRow = {
  boundary_id: string;
  subject_key: string;
  subject_revision: string | null;
  state: 'active' | 'retrying' | 'continuation';
  stage: 'scan' | 'hydrate' | 'settle';
  retry_token: string | null;
  retry_owner: string | null;
  continuation_kind: string | null;
  continuation_key: string | null;
  error_message: string;
  disposition_detail: string;
  detected_at: string;
  updated_at: string;
};

const boundary = 'test-boundary';
const INITIAL_TIME = Date.parse('2026-08-03T02:00:00.000Z');

function fingerprintSubject(key = 'subject-1', revision = 'revision-1'): RecoverySubject {
  return {
    key,
    revision: { kind: 'fingerprint', value: revision },
  };
}

function activeWrite(subject: RecoverySubject = fingerprintSubject()): RecoveryQuarantineWrite {
  return {
    boundary,
    subject,
    state: 'active',
    stage: 'hydrate',
    errorMessage: 'invalid recovery row',
    detail: 'retained for operator retry',
  };
}

function readRow(db: Database, subjectKey = 'subject-1'): QuarantineRow | undefined {
  return db
    .prepare<
      [string, string],
      QuarantineRow
    >('SELECT * FROM recovery_quarantine WHERE boundary_id = ? AND subject_key = ?')
    .get(boundary, subjectKey);
}

function seedRetryingRow(db: Database, subject: RecoverySubject = fingerprintSubject()): void {
  const subjectRevision = subject.revision.kind === 'fingerprint' ? subject.revision.value : null;
  db.prepare<[string, string, string | null]>(
    `INSERT INTO recovery_quarantine (
       boundary_id,
       subject_key,
       subject_revision,
       state,
       stage,
       retry_token,
       retry_owner,
       continuation_kind,
       continuation_key,
       error_message,
       disposition_detail,
       detected_at,
       updated_at
     ) VALUES (?, ?, ?, 'retrying', 'settle', 'token-1', 'owner-1', NULL, NULL,
               'retry in progress', 'claimed by coordinator',
               '2026-08-03T01:00:00.000Z', '2026-08-03T01:01:00.000Z')`,
  ).run(boundary, subject.key, subjectRevision);
}

describe('RecoveryQuarantineStore', () => {
  let db: Database;
  let quarantine: RecoveryQuarantineStore;
  let nowMs: number;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    nowMs = INITIAL_TIME;
    quarantine = new RecoveryQuarantineStore(db, { now: () => nowMs });
  });

  afterEach(() => {
    db.close();
  });

  it('should create the recovery quarantine schema after the expansion manifest catalog', () => {
    const ddl = currentCoralStoreFormat().manifest.ddl;
    expect(ddl.indexOf('CREATE TABLE IF NOT EXISTS recovery_quarantine')).toBeGreaterThan(
      ddl.indexOf('CREATE TABLE IF NOT EXISTS expansion_manifest_catalog'),
    );

    const columns = db.prepare("PRAGMA table_info('recovery_quarantine')").all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(columns.map(({ name }) => name)).toEqual([
      'boundary_id',
      'subject_key',
      'subject_revision',
      'state',
      'stage',
      'retry_token',
      'retry_owner',
      'continuation_kind',
      'continuation_key',
      'error_message',
      'disposition_detail',
      'detected_at',
      'updated_at',
    ]);
    expect(columns.filter(({ pk }) => pk > 0).map(({ name, pk }) => ({ name, pk }))).toEqual([
      { name: 'boundary_id', pk: 1 },
      { name: 'subject_key', pk: 2 },
    ]);

    expect(() =>
      db.exec(`INSERT INTO recovery_quarantine (
        boundary_id, subject_key, state, stage, error_message, disposition_detail, detected_at, updated_at
      ) VALUES ('bad-boundary', 'bad-subject', 'invalid', 'scan', 'error', 'detail',
                '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')`),
    ).toThrow();
  });

  it('should read and upsert active and continuation records', () => {
    const subject = fingerprintSubject();
    expect(quarantine.read(boundary, subject.key)).toBeNull();
    expect(quarantine.upsert(activeWrite(subject))).toBe(true);

    const inserted = readRow(db);
    expect(inserted).toMatchObject({
      boundary_id: boundary,
      subject_key: subject.key,
      subject_revision: 'revision-1',
      state: 'active',
      stage: 'hydrate',
      retry_token: null,
      retry_owner: null,
      continuation_kind: null,
      continuation_key: null,
      error_message: 'invalid recovery row',
      disposition_detail: 'retained for operator retry',
    });
    expect(Date.parse(inserted?.detected_at ?? '')).not.toBeNaN();
    expect(inserted?.updated_at).toBe(inserted?.detected_at);
    expect(quarantine.read(boundary, subject.key)).toEqual({
      boundary,
      subject,
      state: 'active',
    });
    expect(quarantine.list()).toEqual([
      expect.objectContaining({
        boundary,
        subject,
        state: 'active',
        stage: 'hydrate',
        retry: null,
        continuation: null,
        errorMessage: 'invalid recovery row',
        detail: 'retained for operator retry',
      }),
    ]);

    db.prepare(
      `UPDATE recovery_quarantine
       SET detected_at = '2026-08-03T01:00:00.000Z', updated_at = '2026-08-03T01:01:00.000Z'
       WHERE boundary_id = 'test-boundary' AND subject_key = 'subject-1'`,
    ).run();
    expect(
      quarantine.upsert({
        boundary,
        subject,
        state: 'continuation',
        stage: 'settle',
        continuation: { kind: 'settlement.v1', key: 'continuation-1' },
        errorMessage: 'settlement is incomplete',
        detail: 'resume the durable continuation',
      }),
    ).toBe(true);

    expect(readRow(db)).toMatchObject({
      subject_revision: 'revision-1',
      state: 'continuation',
      stage: 'settle',
      retry_token: null,
      retry_owner: null,
      continuation_kind: 'settlement.v1',
      continuation_key: 'continuation-1',
      error_message: 'settlement is incomplete',
      disposition_detail: 'resume the durable continuation',
      detected_at: '2026-08-03T01:00:00.000Z',
    });
    expect(readRow(db)?.updated_at).not.toBe('2026-08-03T01:01:00.000Z');
  });

  it('should stamp every persisted transition from the runtime clock', () => {
    const subject = fingerprintSubject();
    expect(quarantine.upsert(activeWrite(subject))).toBe(true);
    expect(readRow(db)).toMatchObject({
      detected_at: '2026-08-03T02:00:00.000Z',
      updated_at: '2026-08-03T02:00:00.000Z',
    });

    nowMs = Date.parse('2026-08-03T02:01:00.000Z');
    expect(
      quarantine.claimRetry({
        boundary,
        subject,
        retry: { owner: 'owner-1', token: 'token-1' },
      }),
    ).toBe(true);
    expect(readRow(db)?.updated_at).toBe('2026-08-03T02:01:00.000Z');

    nowMs = Date.parse('2026-08-03T02:02:00.000Z');
    expect(
      quarantine.reclaimRetry({
        boundary,
        subject,
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
        retry: { owner: 'owner-2', token: 'token-2' },
      }),
    ).toBe(true);
    expect(readRow(db)?.updated_at).toBe('2026-08-03T02:02:00.000Z');

    nowMs = Date.parse('2026-08-03T02:03:00.000Z');
    expect(
      quarantine.upsert({
        ...activeWrite(subject),
        expectedRetry: { owner: 'owner-2', token: 'token-2' },
      }),
    ).toBe(true);
    expect(readRow(db)).toMatchObject({
      detected_at: '2026-08-03T02:00:00.000Z',
      updated_at: '2026-08-03T02:03:00.000Z',
    });
  });

  it('should map a nullable revision to an until-cleared subject', () => {
    const subject: RecoverySubject = {
      key: 'scan',
      revision: { kind: 'until-cleared' },
    };

    expect(quarantine.upsert(activeWrite(subject))).toBe(true);
    expect(readRow(db, 'scan')?.subject_revision).toBeNull();
    expect(quarantine.read(boundary, 'scan')).toEqual({
      boundary,
      subject,
      state: 'active',
    });
  });

  it('should converge before hydration against persisted fingerprint and until-cleared rows', async () => {
    type Envelope = { readonly key: string; readonly revision: string; readonly value: string };
    type Decoded = { readonly key: string; readonly value: string };

    let envelope: Envelope = { key: 'subject-1', revision: 'revision-1', value: 'old' };
    const recoverySource = defineRecoverySource({
      boundary,
      scanSubject: { key: 'scan', revision: { kind: 'until-cleared' } },
      scan: () => [envelope],
      subject: (raw): RecoverySubject => fingerprintSubject(raw.key, raw.revision),
    });
    const hydrate = vi.fn((raw: Envelope): Decoded => ({ key: raw.key, value: raw.value }));
    const recoveryPolicy: RecoveryPolicy<Envelope, Decoded> = {
      signal: new AbortController().signal,
      quarantine,
      processLocalCleanup: { kind: 'not-required' },
      hydrate,
      requiredObligations: () => [],
      settle: () => ({
        kind: 'advanced',
        outcome: 'settled',
        facts: [],
        detail: 'settled by the SQLite convergence test',
      }),
      onFault: ({ error }) => ({ kind: 'fatal', error }),
    };

    expect(quarantine.upsert(activeWrite(fingerprintSubject()))).toBe(true);
    db.prepare(
      `UPDATE recovery_quarantine
       SET state = 'retrying', retry_owner = 'old-owner', retry_token = 'old-token'
       WHERE boundary_id = 'test-boundary' AND subject_key = 'subject-1'`,
    ).run();

    const unchanged = await RecoveryContainment.each(recoverySource, recoveryPolicy);
    expect(unchanged).toMatchObject({ advanced: 0, skipped: 1 });
    expect(hydrate).not.toHaveBeenCalled();

    envelope = { key: 'subject-1', revision: 'revision-2', value: 'fixed' };
    const changedWhileRetrying = await RecoveryContainment.each(recoverySource, recoveryPolicy);
    expect(changedWhileRetrying).toMatchObject({ advanced: 0, skipped: 1 });
    expect(quarantine.read(boundary, 'subject-1')).toMatchObject({
      state: 'retrying',
      retry: { owner: 'old-owner', token: 'old-token' },
    });
    expect(hydrate).not.toHaveBeenCalled();

    db.prepare(
      `UPDATE recovery_quarantine
       SET state = 'active', retry_owner = NULL, retry_token = NULL
       WHERE boundary_id = 'test-boundary' AND subject_key = 'subject-1'`,
    ).run();
    const changed = await RecoveryContainment.each(recoverySource, recoveryPolicy);
    expect(changed).toMatchObject({ advanced: 1, skipped: 0 });
    expect(hydrate).toHaveBeenCalledOnce();
    expect(quarantine.read(boundary, 'subject-1')).toBeNull();

    const heldSubject: RecoverySubject = {
      key: 'held',
      revision: { kind: 'until-cleared' },
    };
    expect(quarantine.upsert(activeWrite(heldSubject))).toBe(true);
    envelope = { key: 'held', revision: 'revision-3', value: 'changed-again' };
    const held = await RecoveryContainment.each(recoverySource, recoveryPolicy);

    expect(held).toMatchObject({ advanced: 0, skipped: 1 });
    expect(hydrate).toHaveBeenCalledOnce();
    expect(readRow(db, 'held')?.subject_revision).toBeNull();
  });

  it('should compare-and-set retry transitions with the exact revision, owner, and token', () => {
    const subject = fingerprintSubject();
    seedRetryingRow(db, subject);

    expect(quarantine.read(boundary, subject.key)).toEqual({
      boundary,
      subject,
      state: 'retrying',
      retry: { owner: 'owner-1', token: 'token-1' },
    });
    expect(quarantine.upsert(activeWrite(subject))).toBe(false);
    expect(readRow(db)?.state).toBe('retrying');
    expect(
      quarantine.upsert({
        ...activeWrite(fingerprintSubject('subject-1', 'revision-2')),
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
      }),
    ).toBe(false);
    expect(
      quarantine.upsert({
        ...activeWrite(subject),
        expectedRetry: { owner: 'owner-1', token: 'stale-token' },
      }),
    ).toBe(false);
    expect(
      quarantine.upsert({
        ...activeWrite(subject),
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
      }),
    ).toBe(true);

    expect(readRow(db)).toMatchObject({
      state: 'active',
      retry_owner: null,
      retry_token: null,
      detected_at: '2026-08-03T01:00:00.000Z',
    });
  });

  it('should claim and reclaim retry ownership by the exact revision, owner, and token', () => {
    const subject = fingerprintSubject();
    expect(quarantine.upsert(activeWrite(subject))).toBe(true);

    expect(
      quarantine.claimRetry({
        boundary,
        subject: fingerprintSubject('subject-1', 'revision-2'),
        retry: { owner: 'owner-1', token: 'token-1' },
      }),
    ).toBe(false);
    expect(
      quarantine.claimRetry({
        boundary,
        subject,
        retry: { owner: 'owner-1', token: 'token-1' },
      }),
    ).toBe(true);
    expect(
      quarantine.claimRetry({
        boundary,
        subject,
        retry: { owner: 'owner-2', token: 'token-2' },
      }),
    ).toBe(false);

    expect(
      quarantine.reclaimRetry({
        boundary,
        subject,
        expectedRetry: { owner: 'owner-1', token: 'stale-token' },
        retry: { owner: 'owner-2', token: 'token-2' },
      }),
    ).toBe(false);
    expect(
      quarantine.reclaimRetry({
        boundary,
        subject,
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
        retry: { owner: 'owner-2', token: 'token-2' },
      }),
    ).toBe(true);
    expect(quarantine.read(boundary, subject.key)).toEqual({
      boundary,
      subject,
      state: 'retrying',
      retry: { owner: 'owner-2', token: 'token-2' },
    });
  });

  it('should protect retrying rows from non-owner deletion and stale completions', () => {
    const subject = fingerprintSubject();
    expect(quarantine.upsert(activeWrite(subject))).toBe(true);
    expect(
      quarantine.delete({
        boundary,
        subject: fingerprintSubject('subject-1', 'revision-2'),
      }),
    ).toBe(false);
    expect(quarantine.delete({ boundary, subject })).toBe(true);
    expect(quarantine.delete({ boundary, subject })).toBe(false);

    seedRetryingRow(db, subject);
    expect(quarantine.delete({ boundary, subject })).toBe(false);
    expect(
      quarantine.delete({
        boundary,
        subject,
        expectedRetry: { owner: 'owner-1', token: 'stale-token' },
      }),
    ).toBe(false);
    expect(
      quarantine.reclaimRetry({
        boundary,
        subject,
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
        retry: { owner: 'owner-2', token: 'token-2' },
      }),
    ).toBe(true);
    expect(
      quarantine.upsert({
        ...activeWrite(subject),
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
      }),
    ).toBe(false);
    expect(
      quarantine.delete({
        boundary,
        subject,
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
      }),
    ).toBe(false);
    expect(quarantine.read(boundary, subject.key)).toEqual({
      boundary,
      subject,
      state: 'retrying',
      retry: { owner: 'owner-2', token: 'token-2' },
    });
    expect(
      quarantine.delete({
        boundary,
        subject,
        expectedRetry: { owner: 'owner-2', token: 'token-2' },
      }),
    ).toBe(true);
  });
});
