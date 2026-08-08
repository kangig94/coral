import {
  providerOperationRecordSchema,
  type ProviderOperationPhase,
  type ProviderOperationRecord,
} from '#src/store/provider-operation-record.js';

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

export type ProviderOperationFixtureOptions = Readonly<{
  job?: number;
  revision?: number;
  retryNotBeforeMs?: number;
  retryCount?: number;
}>;

export function providerOperationRecord(
  phase: ProviderOperationPhase,
  options: ProviderOperationFixtureOptions = {},
): ProviderOperationRecord {
  const proxyInstanceId = uuid(3);
  const common = {
    version: 1,
    operation: {
      jobId: uuid(options.job ?? 1),
      operationId: uuid(2),
      proxyInstanceId,
      buildSetId: uuid(4),
    },
    locator: {
      hostFingerprint: 'a'.repeat(64),
      proxy: {
        instanceId: proxyInstanceId,
        pid: 101,
        processStartedAtSeconds: 1_000,
        controlEndpoint: '/tmp/coral-proxy.sock',
      },
      guardian: {
        instanceId: uuid(5),
        pid: 102,
        processStartedAtSeconds: 1_001,
        controlEndpoint: '/tmp/coral-guardian.sock',
      },
      reaper: {
        instanceId: uuid(6),
        pid: 103,
        processStartedAtSeconds: 1_002,
        controlEndpoint: '/tmp/coral-reaper.sock',
      },
      containment: {
        pid: 101,
        processStartedAtSeconds: 1_000,
        processGroupId: 101,
        kind: 'process-group',
      },
    },
    prepareAttemptKey: 'b'.repeat(64),
    revision: options.revision ?? 0,
    retryNotBeforeMs: options.retryNotBeforeMs ?? 0,
    retryCount: options.retryCount ?? 0,
    lastError: null,
  } as const;
  const prepared = {
    reservation: uuid(7),
    providerRoot: { pid: 104, processStartedAtSeconds: 1_003 },
    jointContainmentReceipt: 'containment-receipt',
  } as const;
  const authorized = { ...prepared, jointActivationReceipt: 'activation-receipt' } as const;
  const executing = {
    ...authorized,
    activationAck: { state: 'executing', committedThroughProviderSeq: 0 },
    committedThroughProviderSeq: 0,
  } as const;

  switch (phase) {
    case 'prepare-pending':
      return providerOperationRecordSchema.parse({ ...common, phase });
    case 'guardian-activation-pending':
      return providerOperationRecordSchema.parse({ ...common, ...prepared, phase });
    case 'proxy-activation-pending':
    case 'activation-resolution-pending':
      return providerOperationRecordSchema.parse({ ...common, ...authorized, phase });
    case 'executing':
      return providerOperationRecordSchema.parse({ ...common, ...executing, phase });
    case 'prestart-cleanup-pending':
      return providerOperationRecordSchema.parse({
        ...common,
        reservation: prepared.reservation,
        phase,
        cleanupIntent: 'release-never-started',
      });
    case 'settlement-pending':
      return providerOperationRecordSchema.parse({
        ...common,
        ...executing,
        committedThroughProviderSeq: 4,
        phase,
        terminalProviderSeq: 4,
        settlementIntent: 'release-after-terminal',
      });
  }
}
