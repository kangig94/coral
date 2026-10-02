import { describe, expect, it, vi } from 'vitest';

import {
  admissionSlotKey,
  canonicalProviderHostSpecMetadata,
  createHostAdmissionCollection,
  ProviderHostUnserviceableError,
  type ProviderHostUnserviceableResponseError,
} from '#src/providers/host-admission.js';
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
    idleRetirement: 'never',
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
  it('correlates a rejected operation only after an accepted exact fact blocks its host', async () => {
    const admission = collection();
    const slot = admissionSlotKey('finding-slot');
    const hostRef = ref('finding-host');
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
    const rawFailure = new Error('raw provider failure');
    await expect(admission.correlateTerminalFailure(hostRef, async () => Promise.reject(rawFailure))).rejects.toBe(
      rawFailure,
    );

    admission.observe(slot, hostRef, fact(7));
    const operation = vi.fn(async () => Promise.reject(rawFailure));
    const correlated = admission.correlateTerminalFailure(hostRef, operation);

    await expect(correlated).rejects.toMatchObject({
      name: 'ProviderHostUnserviceableResponseError',
      hostRef,
      providerCause: rawFailure,
    } satisfies Partial<ProviderHostUnserviceableResponseError>);
    expect(operation).toHaveBeenCalledOnce();
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
