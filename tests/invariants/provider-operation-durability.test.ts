import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  decodeProviderOperationRecord,
  providerOperationRecordSchema,
  type ProviderOperationPhase,
} from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const PHASES = [
  'prepare-pending',
  'guardian-activation-pending',
  'proxy-activation-pending',
  'executing',
  'prestart-cleanup-pending',
  'activation-resolution-pending',
  'settlement-pending',
] as const satisfies readonly ProviderOperationPhase[];

describe('provider operation durability', () => {
  it('requires every field of the prepare source when decoding a pending prepare', () => {
    const record = providerOperationRecord('prepare-pending');
    const sourceFields = [
      'jobLaunchEventSeq',
      'sessionId',
      'sessionVersion',
      'platform',
      'childAuthorization',
    ] as const;
    const authorizationFields = ['principalWire', 'namespace', 'expiresAtMs'] as const;

    const withoutSource = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    delete withoutSource.prepareSource;
    expect(() => decodeProviderOperationRecord(JSON.stringify(withoutSource)), 'prepareSource').toThrow(
      /prepareSource/u,
    );

    for (const field of sourceFields) {
      const candidate = JSON.parse(JSON.stringify(record)) as Record<string, Record<string, unknown>>;
      delete candidate.prepareSource?.[field];
      expect(() => decodeProviderOperationRecord(JSON.stringify(candidate)), field).toThrow(/prepareSource/u);
    }
    for (const field of authorizationFields) {
      const candidate = JSON.parse(JSON.stringify(record)) as {
        prepareSource?: { childAuthorization?: Record<string, unknown> };
      };
      delete candidate.prepareSource?.childAuthorization?.[field];
      expect(() => decodeProviderOperationRecord(JSON.stringify(candidate)), field).toThrow(/childAuthorization/u);
    }
  });

  it('keeps envelopes, environments, and bearer handles outside every durable phase schema', () => {
    const forbidden = ['prepared', 'baseEnv', 'protectedEnv', 'childPrincipalHandle'] as const;

    for (const phase of PHASES) {
      for (const field of forbidden) {
        expect(
          providerOperationRecordSchema.safeParse({ ...providerOperationRecord(phase), [field]: 'forbidden' }).success,
          `${phase} accepted ${field}`,
        ).toBe(false);
      }
    }

    const pending = providerOperationRecord('prepare-pending');
    if (pending.phase !== 'prepare-pending') throw new Error('expected prepare-pending fixture');
    expect(
      providerOperationRecordSchema.safeParse({
        ...pending,
        prepareSource: {
          ...pending.prepareSource,
          childAuthorization: { ...pending.prepareSource.childAuthorization, handle: 'bearer' },
        },
      }).success,
    ).toBe(false);
  });

  it('funnels every prepare send through the committed fingerprint guard', () => {
    const source = readFileSync(
      new URL('../../src/coordinator/services/provider-operation-reconciler.ts', import.meta.url),
      'utf8',
    );
    const sends = source.match(/\.prepareOperation\(/gu) ?? [];
    const guardedSend = source.slice(
      source.indexOf('async #sendJournaledPrepare('),
      source.indexOf('  #acceptPrepareResult('),
    );
    const attemptMatch = source.slice(
      source.indexOf('  #attemptMatchesRecord('),
      source.indexOf('  async #sendJournaledPrepare('),
    );

    expect(sends).toHaveLength(1);
    expect(guardedSend.indexOf('#attemptMatchesRecord(record, attempt)')).toBeGreaterThanOrEqual(0);
    expect(guardedSend.indexOf('authority.prepareOperation(attempt)')).toBeGreaterThan(
      guardedSend.indexOf('#attemptMatchesRecord(record, attempt)'),
    );
    expect(attemptMatch).toContain('attempt.request.prepareAttemptNumber === record.prepareAttemptNumber');
    expect(attemptMatch).toContain('operationPrepareAttemptKey(attempt.request) === record.prepareAttemptKey');
    expect(attemptMatch).toContain('attempt.prepareAttemptKey === record.prepareAttemptKey');
  });

  it('keeps attempt rotation behind matching release proof and its CAS ahead of the send', () => {
    const source = readFileSync(
      new URL('../../src/coordinator/services/provider-operation-reconciler.ts', import.meta.url),
      'utf8',
    );
    const recovery = source.slice(
      source.indexOf('  async #recoverPrepare('),
      source.indexOf('  async #driveGuardianActivation('),
    );

    expect(recovery).toContain('released.prepareAttemptNumber !== record.prepareAttemptNumber');
    expect(recovery).toContain('released.prepareAttemptKey !== record.prepareAttemptKey');
    expect(recovery.indexOf('authority.cancelOperation(')).toBeLessThan(recovery.indexOf('materializePrepare(record)'));
    expect(recovery.indexOf('materializePrepare(record)')).toBeLessThan(
      recovery.indexOf('compareAndSwapProviderOperation('),
    );
    expect(recovery.indexOf('compareAndSwapProviderOperation(')).toBeLessThan(
      recovery.indexOf('#sendJournaledPrepare(rotated, attempt, authority)'),
    );
  });

  it('requires a complete activation receipt bound to the durable locator and job', () => {
    const executing = providerOperationRecord('executing');
    if (executing.phase !== 'executing') throw new Error('expected executing fixture');
    for (const field of ['activationFingerprint', 'startedAt', 'hostRef', 'committedThroughProviderSeq'] as const) {
      const candidate = JSON.parse(JSON.stringify(executing)) as {
        activationAck: Record<string, unknown>;
      };
      delete candidate.activationAck[field];
      expect(providerOperationRecordSchema.safeParse(candidate).success, field).toBe(false);
    }
    expect(
      providerOperationRecordSchema.safeParse({
        ...executing,
        activationAck: {
          ...executing.activationAck,
          hostRef: { ...executing.activationAck.hostRef, fingerprint: 'd'.repeat(64) },
        },
      }).success,
    ).toBe(false);
    expect(
      providerOperationRecordSchema.safeParse({
        ...executing,
        activationAck: {
          ...executing.activationAck,
          hostRef: {
            ...executing.activationAck.hostRef,
            leaseMode: 'job-exclusive',
            ownerJobId: '00000000-0000-4000-8000-000000000099',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('constructs runtime publication directly from the activation receipt', () => {
    const source = readFileSync(
      new URL('../../src/coordinator/services/provider-operation-reconciler.ts', import.meta.url),
      'utf8',
    );
    const commit = source.slice(source.indexOf('  async #commitExecuting('), source.indexOf('  #registerExecuting('));

    expect(commit).toContain('startedAt: activationAck.startedAt');
    expect(commit).toContain('provider: activationAck.hostRef.provider');
    expect(commit).toContain('hostRef: activationAck.hostRef');
    expect(commit).not.toContain('acquiredHostRef');
    expect(commit).not.toContain('requestFor');
  });
});
