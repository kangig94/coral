import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  RecoveryContainment,
  canonicalRecoveryRevision,
  compositeRecoveryRevision,
  defineCompositeRecoverySource,
  defineRecoverySource,
  type RecoveryDisposition,
  type RecoveryObligationId,
  type RecoveryPolicy,
  type RecoveryQuarantineDelete,
  type RecoveryQuarantinePort,
  type RecoveryQuarantineRecord,
  type RecoveryQuarantineWrite,
  type RecoveryReceipt,
  type RecoveryRevisionDependency,
  type RecoveryRevisionField,
  type RecoverySettlementFact,
  type RecoverySource,
  type RecoverySubject,
} from '#src/recovery/containment.js';

type Raw = {
  readonly key: string;
  readonly revision: string;
  readonly value: string;
};

type Item = {
  readonly key: string;
  readonly value: string;
};

type CancellationCheckpoint =
  | 'before scan'
  | 'after scan'
  | 'before hydrate'
  | 'after hydrate'
  | 'before settle'
  | 'after settle'
  | 'on scan fault'
  | 'on hydrate fault'
  | 'on settle fault';

const cancellationCheckpoints: readonly [
  checkpoint: CancellationCheckpoint,
  expectedCalls: readonly [scan: number, hydrate: number, settle: number],
][] = [
  ['before scan', [0, 0, 0]],
  ['after scan', [1, 0, 0]],
  ['before hydrate', [1, 0, 0]],
  ['after hydrate', [1, 1, 0]],
  ['before settle', [1, 1, 0]],
  ['after settle', [1, 1, 1]],
  ['on scan fault', [1, 0, 0]],
  ['on hydrate fault', [1, 1, 0]],
  ['on settle fault', [1, 1, 1]],
];

const boundary = 'test-boundary';
const settledObligation = 'test.settled' as RecoveryObligationId;

class FakeQuarantinePort implements RecoveryQuarantinePort {
  readonly records = new Map<string, RecoveryQuarantineRecord>();
  readonly writes: RecoveryQuarantineWrite[] = [];
  readonly deletes: RecoveryQuarantineDelete[] = [];
  readonly events: string[];
  readError: Error | undefined;
  upsertError: Error | undefined;
  deleteError: Error | undefined;

  constructor(events: string[] = []) {
    this.events = events;
  }

  read(recordBoundary: string, subjectKey: string): RecoveryQuarantineRecord | null {
    this.events.push(`read:${subjectKey}`);
    if (this.readError !== undefined) throw this.readError;
    return this.records.get(recordKey(recordBoundary, subjectKey)) ?? null;
  }

  upsert(write: RecoveryQuarantineWrite): boolean {
    this.events.push(`upsert:${write.subject.key}`);
    if (this.upsertError !== undefined) throw this.upsertError;
    if (!this.canUpsert(write)) return false;

    this.writes.push(write);
    this.records.set(recordKey(write.boundary, write.subject.key), {
      boundary: write.boundary,
      subject: write.subject,
      state: write.state,
    });
    return true;
  }

  delete(request: RecoveryQuarantineDelete): boolean {
    this.events.push(`delete:${request.subject.key}`);
    if (this.deleteError !== undefined) throw this.deleteError;
    const key = recordKey(request.boundary, request.subject.key);
    const current = this.records.get(key);
    if (!current || !sameSubject(current.subject, request.subject)) return false;
    if (request.expectedRetry) {
      if (
        current.state !== 'retrying' ||
        current.retry?.owner !== request.expectedRetry.owner ||
        current.retry?.token !== request.expectedRetry.token
      ) {
        return false;
      }
    } else if (current.state === 'retrying') {
      return false;
    }

    this.deletes.push(request);
    this.records.delete(key);
    return true;
  }

  private canUpsert(write: RecoveryQuarantineWrite): boolean {
    const current = this.records.get(recordKey(write.boundary, write.subject.key));
    if (!write.expectedRetry) return current?.state !== 'retrying';
    return (
      current?.state === 'retrying' &&
      current.retry?.owner === write.expectedRetry.owner &&
      current.retry.token === write.expectedRetry.token &&
      sameSubject(current.subject, write.expectedRetry.subject)
    );
  }
}

function recordKey(recordBoundary: string, subjectKey: string): string {
  return `${recordBoundary}:${subjectKey}`;
}

function sameSubject(left: RecoverySubject, right: RecoverySubject): boolean {
  if (left.key !== right.key || left.revision.kind !== right.revision.kind) {
    return false;
  }
  return (
    left.revision.kind === 'until-cleared' ||
    (right.revision.kind === 'fingerprint' && left.revision.value === right.revision.value)
  );
}

function raw(key: string, value = key, revision = `rev-${key}`): Raw {
  return { key, value, revision };
}

function subject(item: Raw): RecoverySubject {
  return {
    key: item.key,
    revision: { kind: 'fingerprint', value: item.revision },
  };
}

function source(
  scan: () => readonly Raw[] | Promise<readonly Raw[]>,
  scanSubject: RecoverySubject = {
    key: 'test-scan',
    revision: { kind: 'until-cleared' },
  },
): RecoverySource<Raw> {
  return defineRecoverySource({
    boundary,
    scanSubject,
    scan,
    subject,
  });
}

function advanced(
  facts: readonly RecoverySettlementFact[] = [
    {
      obligation: settledObligation,
      outcome: 'done' as const,
      authorityRef: 'test-authority',
    },
  ],
): RecoveryDisposition {
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts,
    detail: 'settled by the test owner',
  };
}

function policy(
  quarantine: RecoveryQuarantinePort,
  overrides: Partial<RecoveryPolicy<Raw, Item>> = {},
): RecoveryPolicy<Raw, Item> {
  return {
    signal: new AbortController().signal,
    quarantine,
    processLocalCleanup: { kind: 'not-required' },
    hydrate: (item) => ({ key: item.key, value: item.value }),
    requiredObligations: () => [settledObligation],
    settle: () => advanced(),
    onFault: ({ error }) => ({ kind: 'fatal', error }),
    ...overrides,
  };
}

describe('recovery/containment', () => {
  it('should hash field-tagged envelope values independently of input order', () => {
    const fields: readonly RecoveryRevisionField[] = [
      { table: 'projection_jobs', key: 'job-1', field: 'status', value: 'running' },
      { table: 'projection_jobs', key: 'job-1', field: 'last_seq', value: 42 },
      { table: 'journal_events', key: '0002', field: 'body', value: new Uint8Array([0, 1, 255]) },
      { table: 'journal_events', key: '0002', field: 'refs', value: null },
    ];

    const revision = canonicalRecoveryRevision(fields);

    expect(revision).toEqual(canonicalRecoveryRevision([...fields].reverse()));
    expect(revision).toEqual({
      kind: 'fingerprint',
      value: 'sha256:51bfaa2a995ab1e1eca79f0782172ad943ac550075de9fec41a1209071d06bc1',
    });

    const mutations: readonly RecoveryRevisionField[][] = [
      fields.map((field, index) => (index === 0 ? { ...field, table: 'projection_workflows' } : field)),
      fields.map((field, index) => (index === 0 ? { ...field, key: 'job-2' } : field)),
      fields.map((field, index) => (index === 0 ? { ...field, field: 'phase' } : field)),
      fields.map((field, index) => (index === 0 ? { ...field, value: 'queued' } : field)),
      fields.map((field, index) => (index === 1 ? { ...field, value: 43 } : field)),
      fields.map((field, index) => (index === 2 ? { ...field, value: new Uint8Array([0, 1, 254]) } : field)),
      fields.map((field, index) => (index === 3 ? { ...field, value: '' } : field)),
    ];
    for (const mutation of mutations) {
      expect(canonicalRecoveryRevision(mutation)).not.toEqual(revision);
    }

    expect(() => canonicalRecoveryRevision([fields[0], { ...fields[0], value: 'duplicate' }])).toThrow(
      'Duplicate recovery revision field',
    );
  });

  it('should fold every nested subject revision into a stable composite fingerprint', () => {
    const fields: readonly RecoveryRevisionField[] = [
      { table: 'retention_work', key: 'session-1:job-1', field: 'attempt', value: 3n },
    ];
    const dependencies: readonly RecoveryRevisionDependency[] = [
      {
        source: 'session-projection',
        subject: { key: 'session-1', revision: { kind: 'fingerprint', value: 'session-revision' } },
      },
      {
        source: 'terminal-outcome',
        subject: { key: 'event-9', revision: { kind: 'fingerprint', value: 'outcome-revision' } },
      },
    ];
    const revision = compositeRecoveryRevision(fields, dependencies);

    expect(revision).toEqual(compositeRecoveryRevision([...fields].reverse(), [...dependencies].reverse()));

    for (let index = 0; index < dependencies.length; index += 1) {
      const changed = dependencies.map((dependency, dependencyIndex) =>
        dependencyIndex === index
          ? {
              ...dependency,
              subject: {
                ...dependency.subject,
                revision: { kind: 'fingerprint' as const, value: `changed-${index}` },
              },
            }
          : dependency,
      );
      expect(compositeRecoveryRevision(fields, changed)).not.toEqual(revision);
    }

    expect(
      compositeRecoveryRevision(fields, [{ ...dependencies[0], source: 'continuation-lease' }, dependencies[1]]),
    ).not.toEqual(revision);
    expect(
      compositeRecoveryRevision(fields, [
        {
          ...dependencies[0],
          subject: { ...dependencies[0].subject, key: 'session-2' },
        },
        dependencies[1],
      ]),
    ).not.toEqual(revision);

    expect(
      compositeRecoveryRevision(fields, [
        dependencies[0],
        {
          ...dependencies[1],
          subject: {
            ...dependencies[1].subject,
            revision: { kind: 'until-cleared' },
          },
        },
      ]),
    ).not.toEqual(revision);
  });

  it('should expose an opaque source and execute scan, hydrate, and settle in order', async () => {
    const events: string[] = [];
    const quarantine = new FakeQuarantinePort(events);
    const recoverySource = defineRecoverySource({
      boundary,
      scanSubject: {
        key: 'scan',
        revision: { kind: 'until-cleared' },
      },
      scan: () => {
        events.push('scan');
        return [raw('one')];
      },
      subject: (item) => {
        events.push(`subject:${item.key}`);
        return subject(item);
      },
    });

    expectTypeOf(recoverySource).not.toHaveProperty('scan');
    expect(Object.keys(recoverySource)).toEqual(['boundary']);
    expect('scan' in recoverySource).toBe(false);

    const report = await RecoveryContainment.each(
      recoverySource,
      policy(quarantine, {
        hydrate: (item) => {
          events.push(`hydrate:${item.key}`);
          return { key: item.key, value: item.value };
        },
        requiredObligations: (item) => {
          events.push(`obligations:${item.key}`);
          return [settledObligation];
        },
        settle: (item) => {
          events.push(`settle:${item.key}`);
          return advanced();
        },
      }),
    );

    expect(events).toEqual(['scan', 'subject:one', 'read:one', 'hydrate:one', 'obligations:one', 'settle:one']);
    expect(report).toEqual({
      advanced: 1,
      quarantined: 0,
      deferred: 0,
      skipped: 0,
      receipts: [],
    });
  });

  it('should route scan faults through onFault and durably quarantine the scan subject', async () => {
    const scanError = new Error('scan failed');
    const quarantine = new FakeQuarantinePort();
    const onFault = vi.fn<RecoveryPolicy<Raw, Item>['onFault']>(() => ({
      kind: 'quarantine',
      detail: 'scan input is unavailable',
    }));

    const report = await RecoveryContainment.each(
      source(() => {
        throw scanError;
      }),
      policy(quarantine, { onFault }),
    );

    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary,
        stage: 'scan',
        error: scanError,
      }),
    );
    expect(quarantine.writes).toEqual([
      expect.objectContaining({
        boundary,
        state: 'active',
        stage: 'scan',
        errorMessage: 'scan failed',
      }),
    ]);
    expect(report.quarantined).toBe(1);
  });

  it.each(cancellationCheckpoints)(
    'should propagate an aborted signal %s without producing a disposition',
    async (checkpoint, expectedCalls) => {
      const controller = new AbortController();
      const cancellation = new Error(`cancelled ${checkpoint}`);
      const phaseError = new Error(`failed ${checkpoint}`);
      const quarantine = new FakeQuarantinePort();
      const abort = () => controller.abort(cancellation);
      const scan = vi.fn((): readonly Raw[] => {
        if (checkpoint === 'after scan') abort();
        if (checkpoint === 'on scan fault') {
          abort();
          throw phaseError;
        }
        return [raw('cancelled')];
      });
      const hydrate = vi.fn((item: Raw): Item => {
        if (checkpoint === 'after hydrate') abort();
        if (checkpoint === 'on hydrate fault') {
          abort();
          throw phaseError;
        }
        return { key: item.key, value: item.value };
      });
      const settle = vi.fn((): RecoveryDisposition => {
        if (checkpoint === 'after settle') abort();
        if (checkpoint === 'on settle fault') {
          abort();
          throw phaseError;
        }
        return advanced();
      });
      const onFault = vi.fn<RecoveryPolicy<Raw, Item>['onFault']>(() => ({
        kind: 'quarantine',
        detail: 'must not be produced for cancellation',
      }));

      if (checkpoint === 'before hydrate') {
        vi.spyOn(quarantine, 'read').mockImplementation(() => {
          abort();
          return null;
        });
      }
      if (checkpoint === 'before scan') abort();

      const recovery = RecoveryContainment.each(
        source(scan),
        policy(quarantine, {
          signal: controller.signal,
          hydrate,
          requiredObligations: () => {
            if (checkpoint === 'before settle') abort();
            return [settledObligation];
          },
          settle,
          onFault,
        }),
      );

      const expectedError = checkpoint.startsWith('on ') ? phaseError : cancellation;
      await expect(recovery).rejects.toBe(expectedError);
      expect(onFault).not.toHaveBeenCalled();
      expect(quarantine.writes).toEqual([]);
      expect(quarantine.deletes).toEqual([]);
      expect([scan.mock.calls.length, hydrate.mock.calls.length, settle.mock.calls.length]).toEqual(expectedCalls);
    },
  );

  it('should preserve the signal abort reason when process-local cleanup is incomplete', async () => {
    const controller = new AbortController();
    const cancellation = new Error('startup recovery cancelled');
    cancellation.name = 'AbortError';
    const cleanupError = new Error('process ownership remains held');
    const quarantine = new FakeQuarantinePort();
    const release = vi.fn(() => ({ kind: 'incomplete' as const, error: cleanupError }));

    const recovery = RecoveryContainment.each(
      source(() => [raw('cancelled-during-settlement')]),
      policy(quarantine, {
        signal: controller.signal,
        processLocalCleanup: { kind: 'boundary-required', release },
        settle: () => {
          controller.abort(cancellation);
          return advanced();
        },
      }),
    );

    await expect(recovery).rejects.toBe(cancellation);
    expect(release).toHaveBeenCalledOnce();
    expect(quarantine.writes).toEqual([]);
  });

  it('should contain an item-local AbortError while the signal is live', async () => {
    const localAbort = new Error('provider aborted one item');
    localAbort.name = 'AbortError';
    const quarantine = new FakeQuarantinePort();
    const onFault = vi.fn<RecoveryPolicy<Raw, Item>['onFault']>(() => ({
      kind: 'quarantine',
      detail: 'item-local provider failure',
    }));

    const report = await RecoveryContainment.each(
      source(() => [raw('local-abort')]),
      policy(quarantine, {
        hydrate: () => {
          throw localAbort;
        },
        onFault,
      }),
    );

    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ stage: 'hydrate', error: localAbort }));
    expect(report.quarantined).toBe(1);
  });

  it('should continue siblings only after hydration and settlement faults are durably contained', async () => {
    const events: string[] = [];
    const quarantine = new FakeQuarantinePort(events);
    quarantine.records.set(recordKey(boundary, 'skipped'), {
      boundary,
      subject: subject(raw('skipped')),
      state: 'active',
    });
    const hydrationError = new Error('cannot decode');
    const settlementError = new Error('cannot settle');

    const report = await RecoveryContainment.each(
      source(() => [raw('bad-hydration'), raw('bad-settlement'), raw('good'), raw('skipped')]),
      policy(quarantine, {
        hydrate: (item) => {
          events.push(`hydrate:${item.key}`);
          if (item.key === 'bad-hydration') throw hydrationError;
          return { key: item.key, value: item.value };
        },
        settle: (item) => {
          events.push(`settle:${item.key}`);
          if (item.key === 'bad-settlement') throw settlementError;
          return advanced();
        },
        onFault: (fault) => {
          events.push(`fault:${fault.stage}:${fault.subject.key}`);
          return fault.stage === 'hydrate'
            ? { kind: 'quarantine', detail: 'malformed envelope' }
            : {
                kind: 'deferred',
                continuation: {
                  kind: 'test-continuation',
                  key: fault.subject.key,
                },
                detail: 'settlement continuation is durable',
              };
        },
      }),
    );

    expect(events.indexOf('upsert:bad-hydration')).toBeLessThan(events.indexOf('hydrate:bad-settlement'));
    expect(events.indexOf('upsert:bad-settlement')).toBeLessThan(events.indexOf('hydrate:good'));
    expect(quarantine.writes).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({ key: 'bad-hydration' }),
        state: 'active',
        stage: 'hydrate',
      }),
      expect.objectContaining({
        subject: expect.objectContaining({ key: 'bad-settlement' }),
        state: 'continuation',
        stage: 'settle',
        continuation: {
          kind: 'test-continuation',
          key: 'bad-settlement',
        },
      }),
    ]);
    expect(report).toMatchObject({
      advanced: 1,
      quarantined: 1,
      deferred: 1,
      skipped: 1,
    });
  });

  it('should skip an unchanged quarantined revision and re-attempt only after the revision changes', async () => {
    const events: string[] = [];
    const quarantine = new FakeQuarantinePort(events);
    let scanned = raw('converging', 'bad-envelope', 'revision-1');
    const hydrate = vi.fn((item: Raw): Item => {
      events.push(`hydrate:${item.revision}`);
      throw new Error(`cannot decode ${item.revision}`);
    });
    const recoverySource = source(() => [scanned]);
    const recoveryPolicy = policy(quarantine, {
      hydrate,
      onFault: () => ({ kind: 'quarantine', detail: 'invalid authoritative envelope' }),
    });

    const first = await RecoveryContainment.each(recoverySource, recoveryPolicy);
    const second = await RecoveryContainment.each(recoverySource, recoveryPolicy);

    expect(first).toMatchObject({ quarantined: 1, skipped: 0 });
    expect(second).toMatchObject({ quarantined: 0, skipped: 1 });
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(quarantine.deletes).toEqual([]);

    scanned = raw('converging', 'fixed-envelope', 'revision-2');
    const thirdStart = events.length;
    const third = await RecoveryContainment.each(recoverySource, recoveryPolicy);

    expect(third).toMatchObject({ quarantined: 1, skipped: 0 });
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(quarantine.deletes).toEqual([
      {
        boundary,
        subject: {
          key: 'converging',
          revision: { kind: 'fingerprint', value: 'revision-1' },
        },
      },
    ]);
    expect(events.slice(thirdStart)).toEqual([
      'read:converging',
      'delete:converging',
      'hydrate:revision-2',
      'upsert:converging',
    ]);
  });

  it('should retain an until-cleared quarantine regardless of the scanned revision', async () => {
    const quarantine = new FakeQuarantinePort();
    quarantine.records.set(recordKey(boundary, 'held'), {
      boundary,
      subject: { key: 'held', revision: { kind: 'until-cleared' } },
      state: 'active',
    });
    let scanned = raw('held', 'first-envelope', 'revision-1');
    const hydrate = vi.fn<RecoveryPolicy<Raw, Item>['hydrate']>();
    const recoverySource = source(() => [scanned]);
    const recoveryPolicy = policy(quarantine, { hydrate });

    const first = await RecoveryContainment.each(recoverySource, recoveryPolicy);
    scanned = raw('held', 'changed-envelope', 'revision-2');
    const second = await RecoveryContainment.each(recoverySource, recoveryPolicy);

    expect(first.skipped).toBe(1);
    expect(second.skipped).toBe(1);
    expect(hydrate).not.toHaveBeenCalled();
    expect(quarantine.deletes).toEqual([]);
    expect(quarantine.records.get(recordKey(boundary, 'held'))?.subject.revision).toEqual({
      kind: 'until-cleared',
    });
  });

  it('should let only the exact one-shot retry authority bypass a matching quarantine', async () => {
    const retrySubject: RecoverySubject = {
      key: 'claimed',
      revision: { kind: 'fingerprint', value: 'revision-1' },
    };
    const quarantine = new FakeQuarantinePort();
    quarantine.records.set(recordKey(boundary, retrySubject.key), {
      boundary,
      subject: retrySubject,
      state: 'retrying',
      retry: { owner: 'owner-1', token: 'token-1' },
    });
    const hydrate = vi.fn((item: Raw): Item => ({ key: item.key, value: item.value }));
    const recoverySource = source(() => [raw('claimed', 'decoded', 'revision-1')], retrySubject);

    const normal = await RecoveryContainment.each(recoverySource, policy(quarantine, { hydrate }));
    expect(normal.skipped).toBe(1);
    expect(hydrate).not.toHaveBeenCalled();

    await expect(
      RecoveryContainment.each(
        recoverySource,
        policy(quarantine, {
          hydrate,
          retry: { subject: retrySubject, owner: 'owner-1', token: 'wrong-token' },
        }),
      ),
    ).rejects.toThrow(`Recovery retry does not own ${boundary}:${retrySubject.key}`);
    expect(hydrate).not.toHaveBeenCalled();

    const retried = await RecoveryContainment.each(
      recoverySource,
      policy(quarantine, {
        hydrate,
        retry: { subject: retrySubject, owner: 'owner-1', token: 'token-1' },
      }),
    );

    expect(retried).toMatchObject({ advanced: 1, skipped: 0 });
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(quarantine.deletes.at(-1)).toEqual({
      boundary,
      subject: retrySubject,
      expectedRetry: { owner: 'owner-1', token: 'token-1' },
    });
  });

  it('should skip a changed revision owned by an active retry and continue settling siblings', async () => {
    const quarantine = new FakeQuarantinePort();
    quarantine.records.set(recordKey(boundary, 'retry-owned'), {
      boundary,
      subject: subject(raw('retry-owned', 'old', 'revision-1')),
      state: 'retrying',
      retry: { owner: 'owner-1', token: 'token-1' },
    });
    const hydrate = vi.fn((item: Raw): Item => ({ key: item.key, value: item.value }));

    const report = await RecoveryContainment.each(
      source(() => [raw('retry-owned', 'changed', 'revision-2'), raw('sibling')]),
      policy(quarantine, { hydrate }),
    );

    expect(report).toMatchObject({ advanced: 1, quarantined: 0, deferred: 0, skipped: 1 });
    expect(hydrate.mock.calls.map(([item]) => item.key)).toEqual(['sibling']);
    expect(quarantine.deletes).toEqual([]);
    expect(quarantine.records.get(recordKey(boundary, 'retry-owned'))).toMatchObject({
      state: 'retrying',
      retry: { owner: 'owner-1', token: 'token-1' },
    });
  });

  it('should skip a non-owner write claimed by an active retry and continue settling siblings', async () => {
    const quarantine = new FakeQuarantinePort();
    const claimedSubject = subject(raw('claimed-during-settlement'));
    const settle = vi.fn((item: Item): RecoveryDisposition => {
      if (item.key === claimedSubject.key) {
        quarantine.records.set(recordKey(boundary, claimedSubject.key), {
          boundary,
          subject: claimedSubject,
          state: 'retrying',
          retry: { owner: 'owner-2', token: 'token-2' },
        });
        return { kind: 'quarantine', detail: 'operator claimed this subject' };
      }
      return advanced();
    });

    const report = await RecoveryContainment.each(
      source(() => [raw(claimedSubject.key), raw('sibling')]),
      policy(quarantine, { settle }),
    );

    expect(report).toMatchObject({ advanced: 1, quarantined: 0, deferred: 0, skipped: 1 });
    expect(settle.mock.calls.map(([item]) => item.key)).toEqual([claimedSubject.key, 'sibling']);
    expect(quarantine.writes).toEqual([]);
    expect(quarantine.records.get(recordKey(boundary, claimedSubject.key))).toMatchObject({
      state: 'retrying',
      retry: { owner: 'owner-2', token: 'token-2' },
    });
  });

  it('should release boundary-required process ownership in finally for every hydrated subject', async () => {
    const events: string[] = [];
    const quarantine = new FakeQuarantinePort(events);
    const settlementError = new Error('cannot settle locally');

    const report = await RecoveryContainment.each(
      source(() => [raw('advanced'), raw('contained')]),
      policy(quarantine, {
        processLocalCleanup: {
          kind: 'boundary-required',
          release: (item) => {
            events.push(`release:${item.key}`);
            return { kind: 'released' };
          },
        },
        settle: (item) => {
          events.push(`settle:${item.key}`);
          if (item.key === 'contained') throw settlementError;
          return advanced();
        },
        onFault: () => ({ kind: 'quarantine', detail: 'durably contained' }),
      }),
    );

    expect(events.indexOf('settle:advanced')).toBeLessThan(events.indexOf('release:advanced'));
    expect(events.indexOf('upsert:contained')).toBeLessThan(events.indexOf('release:contained'));
    expect(events.filter((event) => event.startsWith('release:'))).toEqual(['release:advanced', 'release:contained']);
    expect(report).toMatchObject({ advanced: 1, quarantined: 1 });
  });

  it('should preserve settlement failure precedence when cleanup also fails', async () => {
    const settlementError = new Error('settlement failed');
    const cleanupError = new Error('process ownership remains held');
    const quarantine = new FakeQuarantinePort();

    let thrown: unknown;
    try {
      await RecoveryContainment.each(
        source(() => [raw('aggregate-failure')]),
        policy(quarantine, {
          processLocalCleanup: {
            kind: 'boundary-required',
            release: () => ({ kind: 'incomplete', error: cleanupError }),
          },
          settle: () => {
            throw settlementError;
          },
        }),
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw new Error('Expected settlement and cleanup failures to aggregate.');
    expect(thrown.errors[0]).toBe(settlementError);
    expect(thrown.errors[1]).toBe(cleanupError);
    expect(thrown.message).toContain(`${boundary}:aggregate-failure`);
  });

  it('should abort after durable containment when boundary-required ownership release is incomplete', async () => {
    const cleanupError = new Error('process ownership remains held');
    const quarantine = new FakeQuarantinePort();
    const settle = vi.fn<RecoveryPolicy<Raw, Item>['settle']>(() => {
      throw new Error('settlement failed');
    });
    const release = vi.fn<
      Extract<RecoveryPolicy<Raw, Item>['processLocalCleanup'], { kind: 'boundary-required' }>['release']
    >(() => ({ kind: 'incomplete', error: cleanupError }));

    await expect(
      RecoveryContainment.each(
        source(() => [raw('held'), raw('unreached')]),
        policy(quarantine, {
          processLocalCleanup: { kind: 'boundary-required', release },
          settle,
          onFault: () => ({ kind: 'quarantine', detail: 'settlement fault is durable' }),
        }),
      ),
    ).rejects.toBe(cleanupError);
    expect(cleanupError.message).toBe(
      `Recovery process-local cleanup did not complete for ${boundary}:held: process ownership remains held`,
    );

    expect(quarantine.writes).toHaveLength(1);
    expect(quarantine.writes[0]?.subject.key).toBe('held');
    expect(release).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('should propagate a thrown boundary-required ownership release failure', async () => {
    const cleanupError = new Error('release threw');
    const quarantine = new FakeQuarantinePort();
    const release = vi.fn(() => {
      throw cleanupError;
    });

    await expect(
      RecoveryContainment.each(
        source(() => [raw('throwing-release')]),
        policy(quarantine, {
          processLocalCleanup: { kind: 'boundary-required', release },
        }),
      ),
    ).rejects.toBe(cleanupError);
    expect(cleanupError.message).toBe(
      `Recovery process-local cleanup did not complete for ${boundary}:throwing-release: release threw`,
    );

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('should reject deferred fault handling without a durable basis', async () => {
    const quarantine = new FakeQuarantinePort();
    const invalidDeferred = {
      kind: 'deferred',
      detail: 'generic retry later',
    } as RecoveryDisposition;

    await expect(
      RecoveryContainment.each(
        source(() => [raw('unclassified')]),
        policy(quarantine, {
          hydrate: () => {
            throw new Error('unclassified decoding failure');
          },
          onFault: () => invalidDeferred,
        }),
      ),
    ).rejects.toThrow('Recovery deferred disposition requires exactly one durable basis');

    expect(quarantine.writes).toEqual([]);

    await expect(
      RecoveryContainment.each(
        source(() => [raw('empty-continuation')]),
        policy(quarantine, {
          settle: () => ({
            kind: 'deferred',
            continuation: { kind: '', key: '' },
            detail: 'empty values are not a durable token',
          }),
        }),
      ),
    ).rejects.toThrow('Recovery deferred continuation requires a non-empty kind and key');

    const ambiguousDeferred = {
      kind: 'deferred',
      continuation: { kind: 'test-continuation', key: 'ambiguous' },
      authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
      detail: 'two durable bases are ambiguous',
    } as RecoveryDisposition;
    await expect(
      RecoveryContainment.each(
        source(() => [raw('ambiguous-defer')]),
        policy(quarantine, { settle: () => ambiguousDeferred }),
      ),
    ).rejects.toThrow('Recovery deferred disposition requires exactly one durable basis');
  });

  it('should defer against an unchanged enumerable source without suppressing its next scan', async () => {
    const quarantine = new FakeQuarantinePort();
    const scan = vi.fn(() => [raw('still-authoritative')]);
    const recoverySource = source(scan);
    const unchangedSource: RecoveryDisposition = {
      kind: 'deferred',
      authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
      detail: 'the authoritative input remains available',
    };
    const recoveryPolicy = policy(quarantine, { settle: () => unchangedSource });

    const first = await RecoveryContainment.each(recoverySource, recoveryPolicy);
    const second = await RecoveryContainment.each(recoverySource, recoveryPolicy);

    expect(first.deferred).toBe(1);
    expect(second.deferred).toBe(1);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(quarantine.writes).toEqual([]);
  });

  it('should reject an unchanged-source defer when enumeration failed', async () => {
    const quarantine = new FakeQuarantinePort();
    const scanError = new Error('enumeration failed');

    await expect(
      RecoveryContainment.each(
        source(() => {
          throw scanError;
        }),
        policy(quarantine, {
          onFault: () => ({
            kind: 'deferred',
            authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
            detail: 'cannot truthfully declare this after a scan fault',
          }),
        }),
      ),
    ).rejects.toThrow('Recovery unchanged-source deferral requires successful enumeration');
  });

  it('should reject an unchanged-source defer from an active retry', async () => {
    const retrySubject = subject(raw('retry-defer'));
    const quarantine = new FakeQuarantinePort();
    quarantine.records.set(recordKey(boundary, retrySubject.key), {
      boundary,
      subject: retrySubject,
      state: 'retrying',
      retry: { owner: 'owner-1', token: 'token-1' },
    });

    await expect(
      RecoveryContainment.each(
        source(() => [raw(retrySubject.key)], retrySubject),
        policy(quarantine, {
          retry: { subject: retrySubject, owner: 'owner-1', token: 'token-1' },
          settle: () => ({
            kind: 'deferred',
            authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
            detail: 'a retry requires a durable continuation',
          }),
        }),
      ),
    ).rejects.toThrow('Recovery retry deferral requires a durable continuation');

    expect(quarantine.records.get(recordKey(boundary, retrySubject.key))).toMatchObject({
      state: 'retrying',
      retry: { owner: 'owner-1', token: 'token-1' },
    });
  });

  it('should reject duplicate and missing settlement facts', async () => {
    const duplicate = advanced([
      { obligation: settledObligation, outcome: 'done' },
      { obligation: settledObligation, outcome: 'not-applicable' },
    ]);
    const quarantine = new FakeQuarantinePort();

    await expect(
      RecoveryContainment.each(
        source(() => [raw('duplicate')]),
        policy(quarantine, { settle: () => duplicate }),
      ),
    ).rejects.toThrow('Duplicate recovery settlement fact: test.settled');

    await expect(
      RecoveryContainment.each(
        source(() => [raw('missing')]),
        policy(quarantine, { settle: () => advanced([]) }),
      ),
    ).rejects.toThrow('Missing recovery settlement fact: test.settled');
  });

  it('should reject an unexpected settlement fact', async () => {
    const unexpectedObligation = 'test.unexpected' as RecoveryObligationId;

    await expect(
      RecoveryContainment.each(
        source(() => [raw('unexpected-fact')]),
        policy(new FakeQuarantinePort(), {
          settle: () =>
            advanced([
              {
                obligation: unexpectedObligation,
                outcome: 'done',
              },
            ]),
        }),
      ),
    ).rejects.toThrow('Unexpected recovery settlement fact: test.unexpected');
  });

  it('should reject duplicate required recovery obligations', async () => {
    await expect(
      RecoveryContainment.each(
        source(() => [raw('duplicate-obligation')]),
        policy(new FakeQuarantinePort(), {
          requiredObligations: () => [settledObligation, settledObligation],
        }),
      ),
    ).rejects.toThrow('Duplicate recovery obligation: test.settled');
  });

  it('should issue sealed receipts and reveal them only to a registered composite source', async () => {
    const quarantine = new FakeQuarantinePort();
    const componentReport = await RecoveryContainment.each(
      source(() => [raw('component', 'decoded-value')]),
      policy(quarantine, { issueReceipts: true }),
    );
    const [receipt] = componentReport.receipts;

    expect(receipt).toBeDefined();
    if (!receipt) throw new Error('Expected the boundary to issue a receipt');
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.keys(receipt)).toEqual([]);
    expect('payload' in receipt).toBe(false);
    expect('subject' in receipt).toBe(false);

    const compositeSource = defineCompositeRecoverySource(componentReport.receipts, {
      boundary: 'composite-boundary',
      scanSubject: {
        key: 'composite-scan',
        revision: { kind: 'until-cleared' },
      },
      scan: (values) =>
        values.map(({ payload, subject: componentSubject }) => ({
          key: `composite:${payload.key}`,
          revision: componentSubject.revision.kind === 'fingerprint' ? componentSubject.revision.value : 'held',
          value: payload.value,
        })),
      subject,
    });
    const compositeReport = await RecoveryContainment.each(compositeSource, policy(quarantine));

    expect(compositeReport.advanced).toBe(1);

    const forged = Object.freeze({}) as RecoveryReceipt<Item>;
    expect(() =>
      defineCompositeRecoverySource([forged], {
        boundary: 'forged-composite',
        scanSubject: {
          key: 'forged',
          revision: { kind: 'until-cleared' },
        },
        scan: () => [],
        subject,
      }),
    ).toThrow('Recovery receipt is not boundary-issued');
  });

  it('should reject a forged source capability', async () => {
    const forged = { boundary } as RecoverySource<Raw>;

    await expect(RecoveryContainment.each(forged, policy(new FakeQuarantinePort()))).rejects.toThrow(
      'Recovery source handle is not registered',
    );
  });

  it('should abort when quarantine reads or writes fail', async () => {
    const readError = new Error('read unavailable');
    const readPort = new FakeQuarantinePort();
    readPort.readError = readError;
    const readFault = vi.fn<RecoveryPolicy<Raw, Item>['onFault']>(() => ({
      kind: 'quarantine',
      detail: 'should not run',
    }));

    await expect(
      RecoveryContainment.each(
        source(() => [raw('read')]),
        policy(readPort, { onFault: readFault }),
      ),
    ).rejects.toBe(readError);
    expect(readFault).not.toHaveBeenCalled();

    const writeError = new Error('write unavailable');
    const writePort = new FakeQuarantinePort();
    writePort.upsertError = writeError;
    await expect(
      RecoveryContainment.each(
        source(() => [raw('write')]),
        policy(writePort, {
          hydrate: () => {
            throw new Error('bad envelope');
          },
          onFault: () => ({
            kind: 'quarantine',
            detail: 'must persist before continuing',
          }),
        }),
      ),
    ).rejects.toBe(writeError);
  });

  it('should abort when fault classification itself fails', async () => {
    const classificationError = new Error('cannot classify recovery fault');
    const quarantine = new FakeQuarantinePort();

    await expect(
      RecoveryContainment.each(
        source(() => [raw('classification')]),
        policy(quarantine, {
          hydrate: () => {
            throw new Error('bad envelope');
          },
          onFault: () => {
            throw classificationError;
          },
        }),
      ),
    ).rejects.toBe(classificationError);
    expect(quarantine.writes).toEqual([]);
  });

  it('should propagate fatal dispositions without counting them', async () => {
    const fatal = new Error('startup cannot continue');
    const quarantine = new FakeQuarantinePort();
    const release = vi.fn(() => ({ kind: 'released' as const }));

    await expect(
      RecoveryContainment.each(
        source(() => [raw('fatal'), raw('unreached')]),
        policy(quarantine, {
          processLocalCleanup: { kind: 'boundary-required', release },
          settle: () => ({ kind: 'fatal', error: fatal }),
        }),
      ),
    ).rejects.toBe(fatal);
    expect(quarantine.writes).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('should complete subject absence only for an exact authoritative retry', async () => {
    const retrySubject: RecoverySubject = {
      key: 'gone',
      revision: { kind: 'fingerprint', value: 'rev-gone' },
    };
    const quarantine = new FakeQuarantinePort();
    quarantine.records.set(recordKey(boundary, retrySubject.key), {
      boundary,
      subject: retrySubject,
      state: 'retrying',
      retry: { owner: 'owner-1', token: 'token-1' },
    });
    const settle = vi.fn<RecoveryPolicy<Raw, Item>['settle']>();

    const report = await RecoveryContainment.each(
      source(() => [], retrySubject),
      policy(quarantine, {
        retry: {
          subject: retrySubject,
          owner: 'owner-1',
          token: 'token-1',
        },
        settle,
      }),
    );

    expect(report.advanced).toBe(1);
    expect(settle).not.toHaveBeenCalled();
    expect(quarantine.deletes).toEqual([
      {
        boundary,
        subject: retrySubject,
        expectedRetry: { owner: 'owner-1', token: 'token-1' },
      },
    ]);

    await expect(
      RecoveryContainment.each(
        source(() => [raw('present')]),
        policy(new FakeQuarantinePort(), {
          requiredObligations: () => [],
          settle: () => ({
            kind: 'advanced',
            outcome: 'subject-absent',
            facts: [],
            detail: 'prose must not select this outcome',
          }),
        }),
      ),
    ).rejects.toThrow('Recovery subject-absent is valid only for an authoritative one-shot retry');
  });
});
