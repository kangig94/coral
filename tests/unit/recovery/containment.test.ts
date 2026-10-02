import { describe, expect, it, vi } from 'vitest';

import {
  RecoveryContainment,
  defineRecoverySource,
  type RecoveryDisposition,
  type RecoveryObligationId,
  type RecoveryPolicy,
  type RecoveryQuarantineDelete,
  type RecoveryQuarantinePort,
  type RecoveryQuarantineRecord,
  type RecoveryQuarantineWrite,
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

const boundary = 'test-boundary';
const settledObligation = 'test.settled' as RecoveryObligationId;

class FakeQuarantinePort implements RecoveryQuarantinePort {
  readonly records = new Map<string, RecoveryQuarantineRecord>();
  readonly writes: RecoveryQuarantineWrite[] = [];
  readonly deletes: RecoveryQuarantineDelete[] = [];
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  read(recordBoundary: string, subjectKey: string): RecoveryQuarantineRecord | null {
    this.events.push(`read:${subjectKey}`);
    return this.records.get(recordKey(recordBoundary, subjectKey)) ?? null;
  }

  upsert(write: RecoveryQuarantineWrite): boolean {
    this.events.push(`upsert:${write.subject.key}`);
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
    return current?.state !== 'retrying';
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

function advanced(): RecoveryDisposition {
  const facts: readonly RecoverySettlementFact[] = [
    {
      obligation: settledObligation,
      outcome: 'done' as const,
      authorityRef: 'test-authority',
    },
  ];
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
});
