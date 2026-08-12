import { describe, expect, it, vi } from 'vitest';

import {
  admissionSlotKey,
  canonicalProviderHostSpecMetadata,
  createHostAdmissionCollection,
  PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET,
  ProviderHostUnserviceableError,
  subscribeProviderHostUnserviceableFindings,
} from '#src/providers/host-admission.js';
import { hostRefSchema } from '#src/providers/host-ref-schema.js';
import { providerOperationPreparePermanentRefusalSchema } from '#src/provider-proxy/protocol.js';
import type { HostRef, ProviderServerSpec } from '#src/providers/contract.js';
import type {
  ProviderHostDiagnosticsSnapshot,
  ProviderResponseDiagnosticFact,
} from '#src/providers/host-diagnostics.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const fingerprint = 'a'.repeat(64);

function ref(instanceId: string): HostRef {
  return Object.freeze({ provider: 'codex', fingerprint, instanceId, leaseMode: 'shared' });
}

function spec(cwd = process.cwd()): ProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir(cwd),
    leaseMode: 'shared',
    idleRetirement: 'none',
  };
}

function fact(generation: number, method = 'config/read'): ProviderResponseDiagnosticFact {
  return Object.freeze({
    factSeq: 1,
    generation,
    requestId: 1,
    method,
    response: Object.freeze({
      kind: 'failure',
      rpcCode: -32_603,
      providerMessage: 'rejected',
      providerData: { cause: 'fixture' },
    }),
    hostLog: Object.freeze({ startSeq: 3, endSeq: 4 }),
  });
}

function diagnostics(): ProviderHostDiagnosticsSnapshot {
  return Object.freeze({
    hostLog: Object.freeze({ entries: Object.freeze([]), retainedBytes: 0, truncatedBeforeSeq: 7 }),
    completedObservations: Object.freeze([]),
    factsTruncatedBeforeSeq: 9,
  });
}

function collection() {
  return createHostAdmissionCollection({
    classify: (_provider, observation) => (observation.method === 'config/read' ? 'unserviceable' : 'unknown'),
  });
}

describe('provider host admission state machine', () => {
  it('publishes only the provider-owned unserviceable classification for the accepted exact fact', async () => {
    const admission = collection();
    const slot = admissionSlotKey('finding-slot');
    const hostRef = ref('finding-host');
    const listener = vi.fn();
    const unsubscribe = subscribeProviderHostUnserviceableFindings(listener);

    try {
      await admission.withFreshPlacement(slot, async (reservation) => {
        reservation.reserveCandidate({
          slot,
          ref: hostRef,
          generation: 7,
          spec: canonicalProviderHostSpecMetadata(spec()),
          host: Object.freeze({ owner: 'test' }),
          inspectDiagnostics: diagnostics,
        });
        reservation.markLive(hostRef, 7);
      });

      admission.observe(slot, hostRef, fact(7, 'thread/start'));
      admission.observe(slot, hostRef, fact(8));
      expect(listener).not.toHaveBeenCalled();

      const classifiedFact = fact(7);
      admission.observe(slot, hostRef, classifiedFact);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({ provider: 'codex', fact: classifiedFact });
    } finally {
      unsubscribe();
    }

    admission.observe(slot, hostRef, fact(7));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('derives the fresh-placement admission decision from every phase', async () => {
    const admission = collection();
    const slot = admissionSlotKey('admission-decision-slot');
    const hostRef = ref('admission-decision-host');

    const expectAdmissionDecision = async (
      phase: 'spawning' | 'live' | 'blocked-live' | 'retired-blocked',
      expected: 'candidate' | 'blocked',
    ): Promise<void> => {
      expect(admission.snapshot().state.get(slot)?.phase).toBe(phase);
      const delegate = vi.fn(async () => undefined);
      let actual: 'candidate' | 'blocked';
      try {
        await admission.withFreshPlacement(slot, delegate);
        actual = 'candidate';
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ProviderHostUnserviceableError);
        actual = 'blocked';
      }

      expect(actual, `${phase} admission decision`).toBe(expected);
      expect(delegate).toHaveBeenCalledTimes(expected === 'candidate' ? 1 : 0);
    };

    await admission.withFreshPlacement(slot, async (reservation) => {
      reservation.reserveCandidate({
        slot,
        ref: hostRef,
        generation: 10,
        spec: canonicalProviderHostSpecMetadata(spec()),
        host: Object.freeze({ owner: 'test' }),
        inspectDiagnostics: diagnostics,
      });
    });
    await expectAdmissionDecision('spawning', 'candidate');

    await admission.withFreshPlacement(slot, async (reservation) => {
      reservation.markLive(hostRef, 10);
    });
    await expectAdmissionDecision('live', 'candidate');

    admission.observe(slot, hostRef, fact(10));
    await expectAdmissionDecision('blocked-live', 'blocked');

    admission.observeRetired(hostRef, 'closed');
    await expectAdmissionDecision('retired-blocked', 'blocked');
  });

  it('retains a blocked exact ref across retirement until exact operator confirmation', async () => {
    const admission = collection();
    const slot = admissionSlotKey('shared-slot');
    const hostRef = ref('host-a');
    const hostSpec = spec('/canonical/workspace');

    await admission.withFreshPlacement(slot, async (reservation) => {
      reservation.reserveCandidate({
        slot,
        ref: hostRef,
        generation: 11,
        spec: canonicalProviderHostSpecMetadata(hostSpec),
        host: Object.freeze({ owner: 'test', hostKey: 'shared-slot' }),
        inspectDiagnostics: diagnostics,
      });
      reservation.markLive(hostRef, 11);
    });
    admission.observe(slot, hostRef, fact(11));

    expect(admission.snapshot().state.get(slot)?.phase).toBe('blocked-live');
    const delegated = vi.fn();
    await expect(admission.withFreshPlacement(slot, async () => delegated())).rejects.toMatchObject({
      code: 'provider_host_unserviceable',
      hostRef,
      remediation: { action: 'evict-provider-host' },
    });
    expect(delegated).not.toHaveBeenCalled();

    admission.observeRetired(hostRef, 'closed');
    const retired = admission.snapshot();
    expect(retired.state.get(slot)?.phase).toBe('retired-blocked');
    expect(retired.tombstones).toEqual([
      expect.objectContaining({
        ref: hostRef,
        spec: expect.objectContaining({ cwd: '/canonical/workspace' }),
        retirement: { status: 'retired', processAbsent: true },
        diagnostics: expect.objectContaining({
          hostLog: expect.objectContaining({ truncatedBeforeSeq: 7 }),
          factsTruncatedBeforeSeq: 9,
        }),
      }),
    ]);
    expect(Object.isFrozen(retired.tombstones[0])).toBe(true);
    expect(Object.isFrozen(retired.tombstones[0]?.diagnostics)).toBe(true);
    await expect(admission.withFreshPlacement(slot, async () => delegated())).rejects.toBeInstanceOf(
      ProviderHostUnserviceableError,
    );

    expect(admission.confirmEvicted(ref('stale-host'))).toBe(false);
    expect(admission.snapshot().state.get(slot)?.phase).toBe('retired-blocked');
    expect(admission.confirmEvicted(hostRef)).toBe(true);
    expect(admission.snapshot()).toMatchObject({ state: new Map(), tombstones: [] });
  });

  it('strictly validates host refs and the structured admission refusal', () => {
    const hostRef = ref('strict-host');
    expect(hostRefSchema.parse(hostRef)).toEqual(hostRef);
    expect(hostRefSchema.safeParse({ ...hostRef, ownerJobId: 'not-allowed' }).success).toBe(false);
    expect(hostRefSchema.safeParse({ ...hostRef, fingerprint: 'A'.repeat(64) }).success).toBe(false);

    const refusal = {
      state: 'permanent-refusal',
      code: 'provider_host_unserviceable',
      disposition: 'terminal-failure',
      reason: 'blocked',
      hostRef,
      remediation: {
        action: 'evict-provider-host',
        command: 'coral-cli backend provider-host evict <host-ref>',
      },
    } as const;
    expect(providerOperationPreparePermanentRefusalSchema.parse(refusal)).toEqual(refusal);
    expect(
      providerOperationPreparePermanentRefusalSchema.safeParse({ ...refusal, disposition: 'local-authorized' }).success,
    ).toBe(false);
    expect(
      providerOperationPreparePermanentRefusalSchema.safeParse({ ...refusal, remediation: undefined }).success,
    ).toBe(false);
    expect(providerOperationPreparePermanentRefusalSchema.safeParse({ ...refusal, extra: true }).success).toBe(false);
  });

  it('ignores a late fact unless slot, exact ref, and generation all match the current candidate', async () => {
    const admission = collection();
    const slot = admissionSlotKey('replacement-slot');
    const first = ref('host-a');
    const second = ref('host-b');
    const hostSpec = spec();

    await admission.withFreshPlacement(slot, async (reservation) => {
      reservation.reserveCandidate({
        slot,
        ref: first,
        generation: 21,
        spec: canonicalProviderHostSpecMetadata(hostSpec),
        host: Object.freeze({ owner: 'test' }),
        inspectDiagnostics: diagnostics,
      });
      reservation.markLive(first, 21);
    });
    admission.observe(slot, first, fact(21));
    admission.observeRetired(first, 'closed');
    expect(admission.confirmEvicted(first)).toBe(true);

    await admission.withFreshPlacement(slot, async (reservation) => {
      reservation.reserveCandidate({
        slot,
        ref: second,
        generation: 22,
        spec: canonicalProviderHostSpecMetadata(hostSpec),
        host: Object.freeze({ owner: 'test' }),
        inspectDiagnostics: diagnostics,
      });
      reservation.markLive(second, 22);
    });
    admission.observe(slot, first, fact(22));
    admission.observe(slot, second, fact(21));

    expect(admission.snapshot().state.get(slot)).toMatchObject({ ref: second, generation: 22, phase: 'live' });
  });

  it('retains positive evidence from a failed spawn and exposes owner-budget diagnostic truncation', async () => {
    const admission = collection();
    const slot = admissionSlotKey('blocked-spawn');
    const hostRef = ref('failed-spawn');
    const oversizedText = 'x'.repeat(PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET + 1);

    await admission.withFreshPlacement(slot, async (reservation) => {
      reservation.reserveCandidate({
        slot,
        ref: hostRef,
        generation: 23,
        spec: canonicalProviderHostSpecMetadata(spec()),
        host: Object.freeze({ owner: 'test' }),
        inspectDiagnostics: () =>
          Object.freeze({
            hostLog: Object.freeze({
              entries: Object.freeze([
                Object.freeze({ seq: 1, observedAt: 1, stream: 'stderr' as const, text: oversizedText }),
              ]),
              retainedBytes: oversizedText.length,
              truncatedBeforeSeq: 0,
            }),
            completedObservations: Object.freeze([]),
            factsTruncatedBeforeSeq: 0,
          }),
      });
    });
    admission.observe(slot, hostRef, fact(23));
    expect(admission.snapshot().state.get(slot)?.phase).toBe('blocked-live');

    admission.observeRetired(hostRef, 'closed');
    const tombstone = admission.snapshot().tombstones[0];
    expect(tombstone).toMatchObject({
      ref: hostRef,
      phase: 'retired-blocked',
      diagnosticsRetention: { ownerBudgetTruncated: true },
      diagnostics: {
        hostLog: { entries: [], truncatedBeforeSeq: 2 },
      },
    });
    expect(admission.snapshot().state.get(slot)?.phase).toBe('retired-blocked');
  });

  it('returns an unblocked retired candidate to empty and serializes reservations only within one slot', async () => {
    const admission = collection();
    const slotA = admissionSlotKey('slot-a');
    const slotB = admissionSlotKey('slot-b');
    const first = ref('candidate-a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];

    const opening = admission.withFreshPlacement(slotA, async (reservation) => {
      calls.push('a:first');
      reservation.reserveCandidate({
        slot: slotA,
        ref: first,
        generation: 31,
        spec: canonicalProviderHostSpecMetadata(spec()),
        host: Object.freeze({ owner: 'test' }),
        inspectDiagnostics: diagnostics,
      });
      await gate;
    });
    const sameSlot = admission.withFreshPlacement(slotA, async () => {
      calls.push('a:second');
    });
    const otherSlot = admission.withFreshPlacement(slotB, async () => {
      calls.push('b:first');
    });

    await otherSlot;
    expect(calls).toEqual(['a:first', 'b:first']);
    release();
    await Promise.all([opening, sameSlot]);
    expect(calls).toEqual(['a:first', 'b:first', 'a:second']);

    admission.observeRetired(first, 'closed');
    expect(admission.snapshot().state.has(slotA)).toBe(false);
    expect(admission.snapshot().tombstones).toEqual([]);
  });
});
