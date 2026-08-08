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
  /** For a caller that must agree with a real store row or a real set locator rather than this file's
   *  synthetic identities. Overriding them here keeps that caller off a second hand-assembled record — the
   *  shape that let this fixture and the schema drift apart once already. */
  operation?: ProviderOperationRecord['operation'];
  locator?: ProviderOperationRecord['locator'];
}>;

export function providerOperationRecord(
  phase: ProviderOperationPhase,
  options: ProviderOperationFixtureOptions = {},
): ProviderOperationRecord {
  const proxyInstanceId = options.operation?.proxyInstanceId ?? uuid(3);
  const common = {
    version: 1,
    operation: options.operation ?? {
      jobId: uuid(options.job ?? 1),
      operationId: uuid(2),
      proxyInstanceId,
      buildSetId: uuid(4),
    },
    locator: options.locator ?? {
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
    prepareAttemptNumber: 1,
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
    activationAck: {
      state: 'executing',
      activationFingerprint: 'c'.repeat(64),
      startedAt: '2026-08-09T12:34:56.000Z',
      hostRef: {
        provider: 'codex',
        fingerprint: common.locator.hostFingerprint,
        instanceId: 'host-instance-1',
        leaseMode: 'job-exclusive',
        ownerJobId: common.operation.jobId,
      },
      committedThroughProviderSeq: 0,
    },
    committedThroughProviderSeq: 0,
  } as const;

  switch (phase) {
    case 'prepare-pending':
      return providerOperationRecordSchema.parse({
        ...common,
        phase,
        prepareSource: {
          jobLaunchEventSeq: 1,
          sessionId: uuid(8),
          sessionVersion: 2,
          platform: 'linux',
          childAuthorization: {
            principalWire: {
              subject: 'agent',
              binding: { kind: 'project', root: '/workspace' },
              attenuatedCaps: ['liveness', 'jobs:read'],
            },
            namespace: 'tests',
            expiresAtMs: 60_000,
          },
        },
      });
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
