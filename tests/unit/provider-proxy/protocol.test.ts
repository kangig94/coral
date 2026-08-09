import { describe, expect, it } from 'vitest';

import {
  assertRecordedSetAgreement,
  controlHeartbeatParamsSchema,
  controlHeartbeatResultSchema,
  controlPairParamsSchema,
  controlPairResultSchema,
  coordinatorIdentitySchema,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  guardianIdentitySchema,
  guardianOperationActivateParamsSchema,
  guardianProxyOperationReleaseParamsSchema,
  guardianProxyOperationReleaseResultSchema,
  guardianRegisterProviderRootParamsSchema,
  guardianStopAndReapParamsSchema,
  MAX_PROXY_CONTROL_FRAME_BYTES,
  operationIdentitySchema,
  providerRootSchema,
  PROVIDER_EVENT_METHOD,
  providerEventBodySchema,
  providerEventRequestSchema,
  providerEventResultSchema,
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_EVENT_COMMIT_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  proxyIdentitySchema,
  proxyOperationActivateParamsSchema,
  proxyOperationActivateResultSchema,
  proxyOperationAdoptParamsSchema,
  proxyOperationAttachParamsSchema,
  proxyOperationAttachResultSchema,
  proxyOperationCancelParamsSchema,
  proxyOperationCancelResultSchema,
  proxyOperationInspectParamsSchema,
  proxyOperationInspectResultSchema,
  proxyOperationPrepareParamsSchema,
  proxyOperationReleaseReceiptSchema,
  proxyOperationReservationParamsSchema,
  proxyOperationStopParamsSchema,
  proxyOperationSettleParamsSchema,
  proxyOperationSettleResultSchema,
  reaperIdentitySchema,
  reaperConfirmProviderRootParamsSchema,
  reaperConfirmProviderRootResultSchema,
  recordedContainmentSchema,
  reaperRecordContainmentResultSchema,
  reaperRecordRedemptionResultSchema,
  reaperRegisterProviderRootParamsSchema,
  reaperRegisterProviderRootResultSchema,
} from '#src/provider-proxy/protocol.js';
import { reaperRecordRedemptionParamsSchema } from '#src/provider-proxy/handoff-capsule.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const HOST_FINGERPRINT = 'a'.repeat(64);

const coordinatorIdentity = {
  instanceId: UUID_A,
  pid: 99,
  processStartedAtSeconds: 199,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
};

const guardianIdentity = {
  guardianInstanceId: UUID_B,
  pid: 101,
  processStartedAtSeconds: 201,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
  hostFingerprint: HOST_FINGERPRINT,
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const reaperIdentity = {
  reaperInstanceId: UUID_C,
  pid: 102,
  processStartedAtSeconds: 202,
  guardianInstanceId: UUID_B,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
  hostFingerprint: HOST_FINGERPRINT,
  canonicalControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'posix-process-group',
};

const proxyIdentity = {
  proxyInstanceId: UUID_A,
  pid: 100,
  processStartedAtSeconds: 200,
  processGroupId: 100,
  guardianInstanceId: UUID_B,
  reaperInstanceId: UUID_C,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
  hostFingerprint: HOST_FINGERPRINT,
  canonicalEndpoint: '/tmp/provider.sock',
};

const operationIdentity = {
  jobId: UUID_A,
  operationId: UUID_B,
  proxyInstanceId: UUID_C,
  buildSetId: UUID_D,
};

describe('provider proxy protocol vocabulary', () => {
  it('publishes the normative frame and timeout constants', () => {
    expect(MAX_PROXY_CONTROL_FRAME_BYTES).toBe(17 * 1024 * 1024);
    expect(PROXY_CONTROL_RPC_TIMEOUT_MS).toBe(5_000);
    expect(PROXY_EVENT_COMMIT_TIMEOUT_MS).toBe(30_000);
    expect(PROXY_STATUS_RPC_TIMEOUT_MS).toBe(500);
  });

  it('validates every identity field set strictly', () => {
    expect(coordinatorIdentitySchema.parse(coordinatorIdentity)).toEqual(coordinatorIdentity);
    expect(guardianIdentitySchema.parse(guardianIdentity)).toEqual(guardianIdentity);
    expect(reaperIdentitySchema.parse(reaperIdentity)).toEqual(reaperIdentity);
    expect(proxyIdentitySchema.parse(proxyIdentity)).toEqual(proxyIdentity);
    expect(operationIdentitySchema.parse(operationIdentity)).toEqual(operationIdentity);
  });

  it('refuses a provider root pid or start time outside the safe-integer range', () => {
    // `providerRootSchema` is this domain's single canonical shape for a provider-root identity, shared by
    // every request or response that names one. Every other pid/processStartedAtSeconds field in this file
    // (`coordinatorIdentitySchema`, `guardianIdentitySchema`, `reaperIdentitySchema`, `proxyIdentitySchema`)
    // rejects an integer outside `Number.isSafeInteger` range via `.safe()`; this schema must too, or a
    // caller that merely names a provider root is held to a laxer bar than one that names any other role.
    expect(providerRootSchema.safeParse({ pid: 1e21, processStartedAtSeconds: 800 }).success).toBe(false);
    expect(providerRootSchema.safeParse({ pid: 7_001, processStartedAtSeconds: 1e21 }).success).toBe(false);
    expect(providerRootSchema.safeParse({ pid: 7_001, processStartedAtSeconds: 800 }).success).toBe(true);
  });

  it('rejects unknown identity fields', () => {
    expect(coordinatorIdentitySchema.safeParse({ ...coordinatorIdentity, unexpected: true }).success).toBe(false);
    expect(guardianIdentitySchema.safeParse({ ...guardianIdentity, unexpected: true }).success).toBe(false);
    expect(reaperIdentitySchema.safeParse({ ...reaperIdentity, unexpected: true }).success).toBe(false);
    expect(proxyIdentitySchema.safeParse({ ...proxyIdentity, unexpected: true }).success).toBe(false);
    expect(operationIdentitySchema.safeParse({ ...operationIdentity, unexpected: true }).success).toBe(false);
  });

  it('rejects non-canonical scalars and open-ended enum values', () => {
    expect(
      proxyIdentitySchema.safeParse({
        ...proxyIdentity,
        proxyInstanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(proxyIdentitySchema.safeParse({ ...proxyIdentity, hostFingerprint: 'a'.repeat(63) }).success).toBe(false);
    expect(
      proxyIdentitySchema.safeParse({ ...proxyIdentity, processGroupId: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(proxyIdentitySchema.safeParse({ ...proxyIdentity, generation: 'gen3' }).success).toBe(false);

    expect(
      coordinatorIdentitySchema.safeParse({
        ...coordinatorIdentity,
        instanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(coordinatorIdentitySchema.safeParse({ ...coordinatorIdentity, generation: 'gen3' }).success).toBe(false);
    expect(coordinatorIdentitySchema.safeParse({ ...coordinatorIdentity, flavor: 'staging' }).success).toBe(false);

    expect(
      guardianIdentitySchema.safeParse({
        ...guardianIdentity,
        guardianInstanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(guardianIdentitySchema.safeParse({ ...guardianIdentity, hostFingerprint: 'a'.repeat(63) }).success).toBe(
      false,
    );
    expect(guardianIdentitySchema.safeParse({ ...guardianIdentity, flavor: 'staging' }).success).toBe(false);

    expect(
      reaperIdentitySchema.safeParse({
        ...reaperIdentity,
        reaperInstanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(reaperIdentitySchema.safeParse({ ...reaperIdentity, containmentKind: '' }).success).toBe(false);
    expect(reaperIdentitySchema.safeParse({ ...reaperIdentity, generation: 'gen3' }).success).toBe(false);

    expect(
      operationIdentitySchema.safeParse({
        ...operationIdentity,
        jobId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(
      operationIdentitySchema.safeParse({ ...operationIdentity, operationId: 'not-a-canonical-uuid' }).success,
    ).toBe(false);
  });

  it('accepts a newline-delimited frame at the byte cap and rejects one byte over it', () => {
    const prefix = '{"jsonrpc":"2.0","id":"frame","method":"control.test","params":"';
    const suffix = '"}\n';
    const paddingBytes = MAX_PROXY_CONTROL_FRAME_BYTES - Buffer.byteLength(prefix + suffix, 'utf8');
    const atLimit = `${prefix}${'a'.repeat(paddingBytes)}${suffix}`;

    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_PROXY_CONTROL_FRAME_BYTES);
    expect(decodeProxyControlFrame(atLimit)).toMatchObject({ method: 'control.test' });

    const overLimit = `${prefix}${'a'.repeat(paddingBytes + 1)}${suffix}`;
    expect(() => decodeProxyControlFrame(overLimit)).toThrowError(ProxyControlProtocolError);
    try {
      decodeProxyControlFrame(overLimit);
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'frame_too_large' });
    }
  });

  it('rejects unknown JSON-RPC envelope fields and emits one canonical newline', () => {
    const invalid = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'frame',
      method: 'control.test',
      unexpected: true,
    })}\n`;

    expect(() => decodeProxyControlFrame(invalid)).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(encodeProxyControlFrame({ jsonrpc: '2.0', id: 'frame', method: 'control.test' })).toMatch(/[^\n]\n$/);
  });
});

describe('shared heartbeat, pairing, and guardian-to-reaper schemas', () => {
  it('accepts each exact request and result while rejecting an unknown field', () => {
    const providerRoot = { pid: 7_001, processStartedAtSeconds: 800 };
    const containment = { ...providerRoot, processGroupId: 7_001, containmentKind: 'posix-process-group' };
    const cases: ReadonlyArray<
      readonly [{ safeParse(value: unknown): { success: boolean } }, Record<string, unknown>]
    > = [
      [controlHeartbeatParamsSchema, { controlEpoch: 1, heartbeatChallenge: 'challenge-1' }],
      [controlHeartbeatResultSchema, { state: 'active', nextHeartbeatChallenge: 'challenge-2' }],
      [controlPairParamsSchema, { pairingSecret: 'shared-secret' }],
      [controlPairResultSchema, { state: 'paired' }],
      [recordedContainmentSchema, containment],
      [reaperRecordContainmentResultSchema, { state: 'containment-recorded', reaper: reaperIdentity }],
      [reaperRegisterProviderRootParamsSchema, { providerRoot }],
      [reaperRegisterProviderRootResultSchema, { state: 'root-recorded' }],
      [reaperConfirmProviderRootParamsSchema, { providerRoot }],
      [reaperConfirmProviderRootResultSchema, { state: 'root-recorded' }],
      [
        reaperRecordRedemptionParamsSchema,
        {
          grantId: UUID_A,
          successor: coordinatorIdentity,
          operations: [operationIdentity],
          redemptionReceipt: 'redemption-receipt',
        },
      ],
      [reaperRecordRedemptionResultSchema, { state: 'redemption-recorded' }],
    ];

    for (const [schema, valid] of cases) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    }
  });
});

describe('provider.event.v1 vocabulary', () => {
  const operation = { jobId: UUID_A, operationId: UUID_B, proxyInstanceId: UUID_C, buildSetId: UUID_D };

  it('publishes the one method name used in both directions of the reverse channel', () => {
    expect(PROVIDER_EVENT_METHOD).toBe('provider.event.v1');
  });

  it('accepts every ProviderEventBody variant, including the progress kind contract.ts has no schema for', () => {
    expect(providerEventBodySchema.safeParse({ kind: 'progress', message: 'tick' }).success).toBe(true);
    expect(
      providerEventBodySchema.safeParse({
        kind: 'continuity',
        conversationRef: 'ref-1',
        resumable: true,
        providerContinuity: null,
      }).success,
    ).toBe(true);
    expect(
      providerEventBodySchema.safeParse({
        kind: 'artifact_handle',
        handle: 'handle-1',
        identity: { kind: 'file', path: '/tmp/artifact' },
      }).success,
    ).toBe(true);
    expect(providerEventBodySchema.safeParse({ kind: 'suspended', reason: 'interrupt_unconfirmed' }).success).toBe(
      true,
    );
    expect(providerEventBodySchema.safeParse({ kind: 'terminal' }).success).toBe(false); // missing required fields
    expect(providerEventBodySchema.safeParse({ kind: 'unknown-kind' }).success).toBe(false);
  });

  it('validates the request strictly: canonical operation identity, a positive seq, and a covered event', () => {
    const valid = { operation, providerSeq: 1, event: { kind: 'progress', message: 'tick' } };
    expect(providerEventRequestSchema.safeParse(valid).success).toBe(true);

    expect(providerEventRequestSchema.safeParse({ ...valid, providerSeq: 0 }).success).toBe(false);
    expect(providerEventRequestSchema.safeParse({ ...valid, providerSeq: -1 }).success).toBe(false);
    expect(providerEventRequestSchema.safeParse({ ...valid, providerSeq: 1.5 }).success).toBe(false);
    expect(providerEventRequestSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    expect(
      providerEventRequestSchema.safeParse({ ...valid, event: { kind: 'progress', message: 'tick', extra: 1 } })
        .success,
    ).toBe(false);
  });

  it('validates both result variants and rejects a kind outside the closed set', () => {
    expect(providerEventResultSchema.safeParse({ kind: 'ack', committedThroughProviderSeq: 0 }).success).toBe(true);
    expect(
      providerEventResultSchema.safeParse({ kind: 'replay', replayFromProviderSeq: 1, reason: 'gap' }).success,
    ).toBe(true);

    expect(providerEventResultSchema.safeParse({ kind: 'ack', committedThroughProviderSeq: -1 }).success).toBe(false);
    expect(
      providerEventResultSchema.safeParse({ kind: 'replay', replayFromProviderSeq: 0, reason: 'gap' }).success,
    ).toBe(false);
    expect(providerEventResultSchema.safeParse({ kind: 'replay', replayFromProviderSeq: 1, reason: '' }).success).toBe(
      false,
    );
    expect(providerEventResultSchema.safeParse({ kind: 'nack', committedThroughProviderSeq: 0 }).success).toBe(false);
  });
});

/**
 * These four request schemas moved here from `guardian.ts` so their one coordinator sender
 * (`provider-proxy-operation-activation.ts` for the first two, `set-authority.ts`'s `stopAndReap` for the
 * third; the fourth's sender is `role-main.ts`) parses the identical schema the guardian itself parses on
 * receipt, before the frame is ever written. Mutation, not assertion: each test below removes a field the
 * real branch fix required (bug 3's missing `jointContainmentReceipt`) or adds one no `.strict()` schema has
 * a place for (bug 1's shape, pointed at a guardian method instead of the proxy's), and observes the schema
 * itself refuse it — proving the sender-side parse this domain now performs would catch the exact mistake
 * that used to reach the wire unvalidated.
 */
describe('guardian control-method request schemas, shared with their one coordinator or proxy sender', () => {
  const operation = { jobId: UUID_A, operationId: UUID_B, proxyInstanceId: UUID_C, buildSetId: UUID_D };
  const providerRoot = { pid: 7_001, processStartedAtSeconds: 800 };

  it('guardian.operation-activate.v1: rejects a payload missing providerRoot, and one carrying an extra field', () => {
    const valid = {
      operation,
      reservation: UUID_A,
      providerRoot,
      jointContainmentReceipt: 'joint-1',
    };
    expect(guardianOperationActivateParamsSchema.safeParse(valid).success).toBe(true);

    // Remove a required field.
    const { providerRoot: _omitted, ...missingProviderRoot } = valid;
    const missing = guardianOperationActivateParamsSchema.safeParse(missingProviderRoot);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['providerRoot'] })]),
      );
    }

    // Add a field this `.strict()` schema has no place for — bug (1)'s exact shape.
    const extra = guardianOperationActivateParamsSchema.safeParse({ ...valid, committedThroughProviderSeq: 0 });
    expect(extra.success).toBe(false);
    if (!extra.success) {
      expect(extra.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
      );
    }
  });

  it('guardian.stop-and-reap.v1: rejects a payload missing providerRoots, and one with an extra field', () => {
    const guardianIdentityFixture = { ...guardianIdentity };
    const reaperIdentityFixture = { ...reaperIdentity };
    const proxyIdentityFixture = { ...proxyIdentity };
    const valid = {
      guardian: guardianIdentityFixture,
      reaper: reaperIdentityFixture,
      proxy: proxyIdentityFixture,
      providerRoots: [providerRoot],
    };
    expect(guardianStopAndReapParamsSchema.safeParse(valid).success).toBe(true);

    const { providerRoots: _omitted, ...missingRoots } = valid;
    expect(guardianStopAndReapParamsSchema.safeParse(missingRoots).success).toBe(false);

    expect(guardianStopAndReapParamsSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });

  it('guardian.register-provider-root.v1: rejects a payload missing the reservation, and one with an extra field', () => {
    const valid = {
      proxy: proxyIdentity,
      operation,
      reservation: UUID_A,
      providerPid: providerRoot.pid,
      providerProcessStartedAtSeconds: providerRoot.processStartedAtSeconds,
    };
    expect(guardianRegisterProviderRootParamsSchema.safeParse(valid).success).toBe(true);

    const { reservation: _omitted, ...missingReservation } = valid;
    expect(guardianRegisterProviderRootParamsSchema.safeParse(missingReservation).success).toBe(false);

    expect(guardianRegisterProviderRootParamsSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });
});

describe('truthful operation wire schemas', () => {
  const operation = { jobId: UUID_A, operationId: UUID_B, proxyInstanceId: UUID_C, buildSetId: UUID_D };
  const prepareAttemptKey = 'f'.repeat(64);

  it('strictly validates proxy-owned guardian release in both directions', () => {
    const request = { proxy: proxyIdentity, operation, reservation: UUID_A };
    expect(guardianProxyOperationReleaseParamsSchema.safeParse(request).success).toBe(true);
    expect(guardianProxyOperationReleaseParamsSchema.safeParse({ ...request, unexpected: true }).success).toBe(false);
    expect(guardianProxyOperationReleaseParamsSchema.safeParse({ proxy: proxyIdentity, operation }).success).toBe(
      false,
    );
    expect(guardianProxyOperationReleaseResultSchema.safeParse({ state: 'membership-absent' }).success).toBe(true);
    expect(
      guardianProxyOperationReleaseResultSchema.safeParse({ state: 'membership-absent', unexpected: true }).success,
    ).toBe(false);
  });

  it('strictly validates inspect, fenced cancel, and cumulative settle requests and results', () => {
    const inspect = { operation, prepareAttemptKey };
    const cancel = { ...inspect, prepareAttemptNumber: 2 };
    const settle = { operation, finalProviderSeq: 7 };
    expect(proxyOperationInspectParamsSchema.safeParse(inspect).success).toBe(true);
    expect(proxyOperationCancelParamsSchema.safeParse(cancel).success).toBe(true);
    expect(proxyOperationSettleParamsSchema.safeParse(settle).success).toBe(true);
    expect(proxyOperationInspectParamsSchema.safeParse({ ...inspect, unexpected: true }).success).toBe(false);
    expect(proxyOperationCancelParamsSchema.safeParse({ operation, prepareAttemptKey }).success).toBe(false);
    expect(proxyOperationCancelParamsSchema.safeParse({ ...cancel, reservation: UUID_A }).success).toBe(false);
    expect(proxyOperationSettleParamsSchema.safeParse({ operation, finalProviderSeq: -1 }).success).toBe(false);

    expect(proxyOperationInspectResultSchema.safeParse({ state: 'absent' }).success).toBe(true);
    expect(proxyOperationCancelResultSchema.safeParse({ state: 'released-never-started', ...cancel }).success).toBe(
      true,
    );
    expect(
      proxyOperationSettleResultSchema.safeParse({
        state: 'released-after-terminal',
        settledThroughProviderSeq: 7,
      }).success,
    ).toBe(true);
    expect(proxyOperationInspectResultSchema.safeParse({ state: 'absent', unexpected: true }).success).toBe(false);
    expect(
      proxyOperationCancelResultSchema.safeParse({
        state: 'released-never-started',
        ...cancel,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      proxyOperationSettleResultSchema.safeParse({
        state: 'released-after-terminal',
        settledThroughProviderSeq: 7,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('requires the complete activation receipt for activation replay and executing inspection', () => {
    const receipt = {
      state: 'executing' as const,
      activationFingerprint: prepareAttemptKey,
      startedAt: '2026-08-09T12:34:56.000Z',
      hostRef: {
        provider: 'codex',
        fingerprint: HOST_FINGERPRINT,
        instanceId: UUID_A,
        leaseMode: 'job-exclusive' as const,
        ownerJobId: operation.jobId,
      },
      committedThroughProviderSeq: 0,
    };

    expect(proxyOperationActivateResultSchema.safeParse(receipt).success).toBe(true);
    expect(proxyOperationInspectResultSchema.safeParse(receipt).success).toBe(true);
    const { hostRef: _hostRef, ...missingHostRef } = receipt;
    expect(proxyOperationActivateResultSchema.safeParse(missingHostRef).success).toBe(false);
    expect(proxyOperationInspectResultSchema.safeParse({ ...receipt, activationAck: receipt }).success).toBe(false);
  });
});

describe('assertRecordedSetAgreement', () => {
  const ROOT_A = { pid: 5_001, processStartedAtSeconds: 900 };
  const ROOT_B = { pid: 5_002, processStartedAtSeconds: 901 };

  it('accepts an exact match between claimed and recorded roots', () => {
    expect(() => assertRecordedSetAgreement('guardian', [ROOT_A], [ROOT_A])).not.toThrow();
  });

  it('accepts a claimed set that undershoots what this role recorded — the enforcer is a superset by construction', () => {
    expect(() => assertRecordedSetAgreement('guardian', [], [ROOT_A])).not.toThrow();
    expect(() => assertRecordedSetAgreement('reaper', [ROOT_A], [ROOT_A, ROOT_B])).not.toThrow();
  });

  it('rejects a claimed root the enforcer never recorded, regardless of what else it claims', () => {
    expect(() => assertRecordedSetAgreement('guardian', [ROOT_B], [ROOT_A])).toThrow(/different provider-root set/u);
    expect(() => assertRecordedSetAgreement('guardian', [ROOT_A, ROOT_B], [ROOT_A])).toThrow(
      /different provider-root set/u,
    );
  });

  it('drives a real LocalOperationRegistry through settle-then-teardown — the coordinator claim a settle racing teardown produces', () => {
    // Not a fake `providerRootsFor: () => []` held in artificial agreement with a guardian that staged
    // nothing: this is the actual write path (`activate` then `settled`) an operation's terminal drives
    // (`provider-event-application.ts`), read back through the actual read path (`providerRootsFor`) teardown
    // uses (`set-authority.ts`'s `stopAndReap`) — proving the two are reconciled by this function, not by
    // holding them in lockstep by construction.
    const registry = new LocalOperationRegistry();
    const identity = { jobId: UUID_A, operationId: UUID_B, proxyInstanceId: UUID_C, buildSetId: UUID_D };
    const executing = providerOperationRecord('executing', { operation: identity });
    const record = providerOperationRecordSchema.parse({ ...executing, providerRoot: ROOT_A });
    if (record.phase !== 'executing') throw new Error('expected executing provider operation');

    registry.activate(record, { stop: async () => {} }, { jobId: record.operation.jobId, pool: 'default' });
    // The operation's terminal commits and the registry forgets it — concurrently, from teardown's own view,
    // with the enforcer that still recorded `ROOT_A` (a released membership does not remove the enforcer's own
    // recorded root — only teardown itself may conclude absence).
    registry.settled(identity);

    const claimed = registry.providerRootsFor(identity.proxyInstanceId);
    expect(claimed).toEqual([]);

    // Before this fix, `assertRecordedSetAgreement`'s exact-equality check made this throw `identity_mismatch`
    // for `[]` vs `[ROOT_A]` — a settled operation's own honest claim, refused as though it were a caller
    // reasoning about a different containment.
    expect(() => assertRecordedSetAgreement('guardian', claimed, [ROOT_A])).not.toThrow();
  });
});

describe('proxy control-method request schemas, shared with their coordinator senders', () => {
  const operation = { jobId: UUID_A, operationId: UUID_B, proxyInstanceId: UUID_C, buildSetId: UUID_D };
  const PREPARED_OPERATION = {
    version: 1 as const,
    provider: 'codex',
    binding: { provider: 'codex', kind: 'account' as const, binding: { account: 'acct-1' } },
    request: {
      action: 'exec' as const,
      sessionId: 'session-1',
      prompt: 'do the thing',
      cwd: '/project',
      bypassPermissions: false,
      coralEnv: {},
    },
    persistedContinuity: null,
    baseEnv: { PATH: '/usr/bin' },
    protectedEnv: {},
    platform: 'linux',
  };

  it('operation.activate.v1: refuses the exact extra field that made every activation fail', () => {
    const valid = {
      operation,
      reservation: UUID_A,
      jointContainmentReceipt: 'joint-1',
      jointActivationReceipt: 'joint-activation-1',
    };
    expect(proxyOperationActivateParamsSchema.safeParse(valid).success).toBe(true);

    // Sharing the strict schema keeps a sender from adding coordinator-only state to the wire contract.
    const extra = proxyOperationActivateParamsSchema.safeParse({ ...valid, committedThroughProviderSeq: 0 });
    expect(extra.success).toBe(false);
    if (!extra.success) {
      expect(extra.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
      );
    }

    const { jointContainmentReceipt: _omitted, ...missingReceipt } = valid;
    const missing = proxyOperationActivateParamsSchema.safeParse(missingReceipt);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['jointContainmentReceipt'] })]),
      );
    }
  });

  it('operation.prepare.v1: requires an explicit positive attempt number and rejects extra fields', () => {
    const valid = {
      operation,
      hostFingerprint: 'a'.repeat(64),
      prepareAttemptNumber: 1,
      prepared: PREPARED_OPERATION,
    };
    expect(proxyOperationPrepareParamsSchema.safeParse(valid).success).toBe(true);

    const { hostFingerprint: _omitted, ...missing } = valid;
    expect(proxyOperationPrepareParamsSchema.safeParse(missing).success).toBe(false);
    expect(proxyOperationPrepareParamsSchema.safeParse({ ...valid, prepareAttemptNumber: 0 }).success).toBe(false);
    expect(proxyOperationPrepareParamsSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });

  it('the reservation shape serves renew, cancel-pending, and activate alike', () => {
    const valid = { operation, reservation: UUID_A };
    expect(proxyOperationReservationParamsSchema.safeParse(valid).success).toBe(true);

    // Activate extends it rather than restating it, so a field the base refuses is refused there too — the
    // property that keeps one schema serving three methods from drifting into three.
    expect(proxyOperationReservationParamsSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    const { reservation: _omitted, ...missing } = valid;
    expect(proxyOperationReservationParamsSchema.safeParse(missing).success).toBe(false);
  });

  it('operation.stop.v1 and operation.adopt.v1: reject an extra field', () => {
    expect(proxyOperationStopParamsSchema.safeParse({ operation, cause: 'signal_abort' }).success).toBe(true);
    expect(
      proxyOperationStopParamsSchema.safeParse({ operation, cause: 'signal_abort', unexpected: true }).success,
    ).toBe(false);

    expect(proxyOperationAdoptParamsSchema.safeParse({ operation, committedThroughProviderSeq: 3 }).success).toBe(true);
    expect(
      proxyOperationAdoptParamsSchema.safeParse({ operation, committedThroughProviderSeq: 3, unexpected: true })
        .success,
    ).toBe(false);
  });

  it('keeps attach and retained release receipts strict', () => {
    const attachRequest = { operation, committedThroughProviderSeq: 3 };
    expect(proxyOperationAttachParamsSchema.safeParse(attachRequest).success).toBe(true);
    expect(proxyOperationAttachParamsSchema.safeParse({ ...attachRequest, unexpected: true }).success).toBe(false);

    const attached = { state: 'attached', replayFromProviderSeq: 4 };
    const absent = { state: 'operation-absent', operation };
    expect(proxyOperationAttachResultSchema.safeParse(attached).success).toBe(true);
    expect(proxyOperationAttachResultSchema.safeParse(absent).success).toBe(true);
    expect(proxyOperationAttachResultSchema.safeParse({ ...attached, unexpected: true }).success).toBe(false);
    expect(proxyOperationAttachResultSchema.safeParse({ state: 'operation-absent' }).success).toBe(false);

    const attempt = {
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey: 'f'.repeat(64),
    };
    const receipts = [
      { state: 'released-never-started', ...attempt },
      { state: 'released-activation-indeterminate', ...attempt },
      { state: 'released-after-terminal', settledThroughProviderSeq: 7 },
    ];
    for (const receipt of receipts) {
      expect(proxyOperationReleaseReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(proxyOperationReleaseReceiptSchema.safeParse({ ...receipt, unexpected: true }).success).toBe(false);
    }
  });
});
