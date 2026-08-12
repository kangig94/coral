import { z } from 'zod';

import { errorMessage } from '../infra/error-format.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { HostRef, ProviderServerSpec } from './contract.js';
import { decodeHostRef, encodeHostRef } from './host-ref-codec.js';
import type {
  InspectedProviderResponseDiagnosticFact,
  ProviderHostDiagnosticsSnapshot,
  ProviderHostLogEntry,
  ProviderResponseDiagnosticFact,
} from './host-diagnostics.js';
import {
  reduceHostServiceability,
  type HostAdmission,
  type HostProcessState,
  type HostServiceability,
  type HostServiceabilityState,
} from './host-serviceability.js';

export type AdmissionSlotKey = string & { readonly __brand: 'AdmissionSlotKey' };

export type AdmissionEntry = Readonly<{
  slot: AdmissionSlotKey;
  ref: HostRef;
  generation: number;
  phase: 'spawning' | 'live' | 'blocked-live' | 'retired-blocked';
}>;

const HOST_ADMISSION_BY_PHASE = {
  spawning: 'candidate',
  live: 'candidate',
  'blocked-live': 'blocked',
  'retired-blocked': 'blocked',
} as const satisfies Readonly<Record<AdmissionEntry['phase'], HostAdmission>>;

function hostAdmissionForPhase(phase: AdmissionEntry['phase']): HostAdmission {
  return HOST_ADMISSION_BY_PHASE[phase];
}

export type HostAdmissionState = ReadonlyMap<AdmissionSlotKey, AdmissionEntry>;

export const providerHostRemediationSchema = z
  .object({
    action: z.literal('evict-provider-host'),
    command: z.literal('coral-cli backend provider-host evict <host-ref>'),
  })
  .strict();

export type ProviderHostRemediation = Readonly<z.output<typeof providerHostRemediationSchema>>;

export const PROVIDER_HOST_UNSERVICEABLE_REMEDIATION: ProviderHostRemediation = Object.freeze({
  action: 'evict-provider-host',
  command: 'coral-cli backend provider-host evict <host-ref>',
});

const PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_PREFIX = 'Provider host ';
const PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_SUFFIX = ' was classified unserviceable.';

export function providerHostUnserviceableTerminalWarning(hostRef: HostRef): string {
  return (
    PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_PREFIX +
    encodeHostRef(hostRef) +
    PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_SUFFIX
  );
}

export function readProviderHostUnserviceableTerminalWarning(warning: string): HostRef | null {
  if (
    !warning.startsWith(PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_PREFIX) ||
    !warning.endsWith(PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_SUFFIX)
  ) {
    return null;
  }
  const encoded = warning.slice(
    PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_PREFIX.length,
    -PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING_SUFFIX.length,
  );
  try {
    return decodeHostRef(encoded);
  } catch {
    return null;
  }
}

export function providerHostUnserviceableMessage(hostRef: HostRef): string {
  const encodedHostRef = encodeHostRef(hostRef);
  return (
    `Provider host ${encodedHostRef} (${hostRef.provider}/${hostRef.instanceId}) is unserviceable. ` +
    `Run coral-cli backend provider-host inspect ${encodedHostRef}, then ` +
    `coral-cli backend provider-host evict ${encodedHostRef} before retrying fresh placement.`
  );
}

export class ProviderHostUnserviceableError extends Error {
  readonly code = 'provider_host_unserviceable';
  readonly hostRef: HostRef;
  readonly remediation: ProviderHostRemediation;

  constructor(hostRef: HostRef) {
    super(providerHostUnserviceableMessage(hostRef));
    this.name = 'ProviderHostUnserviceableError';
    this.hostRef = freezeHostRef(hostRef);
    this.remediation = PROVIDER_HOST_UNSERVICEABLE_REMEDIATION;
    Object.setPrototypeOf(this, ProviderHostUnserviceableError.prototype);
  }
}

export class ProviderHostUnserviceableResponseError extends Error {
  readonly code = 'provider_host_unserviceable_response';
  readonly hostRef: HostRef;
  readonly providerCause: unknown;

  constructor(hostRef: HostRef, providerCause: unknown) {
    super(errorMessage(providerCause));
    this.name = 'ProviderHostUnserviceableResponseError';
    this.hostRef = freezeHostRef(hostRef);
    this.providerCause = providerCause;
    Object.setPrototypeOf(this, ProviderHostUnserviceableResponseError.prototype);
  }
}

export type ProviderHostCanonicalSpecMetadata = Readonly<{
  provider: string;
  command: string;
  args: readonly string[];
  cwd: CanonicalWorkDir | null;
  leaseMode: 'shared' | 'job-exclusive';
  idleRetirement: 'host-reported' | 'none' | null;
}>;

export type ProviderHostCanonicalOwnerMetadata = Readonly<Record<string, string | number | boolean | null>>;

export type ProviderHostTombstone = Readonly<{
  slot: AdmissionSlotKey;
  ref: HostRef;
  generation: number;
  phase: 'retired-blocked';
  spec: ProviderHostCanonicalSpecMetadata;
  host: ProviderHostCanonicalOwnerMetadata;
  retirement: Readonly<{ status: 'retired'; processAbsent: true }>;
  diagnostics: ProviderHostDiagnosticsSnapshot;
  diagnosticsRetention: Readonly<{ ownerBudgetTruncated: boolean }>;
}>;

export type HostAdmissionSnapshot = Readonly<{
  state: HostAdmissionState;
  tombstones: readonly ProviderHostTombstone[];
}>;

// These owner-wide caps apply only to retained diagnostic payload. Admission identity, canonical metadata,
// retirement status, and the tombstone itself are never evicted by budget enforcement.
export const PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET = 4 * 1024 * 1024;
export const PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_FACT_BUDGET = 256;

type AdmissionEvent =
  | Readonly<{ kind: 'reserve'; entry: AdmissionEntry }>
  | Readonly<{ kind: 'mark-live'; slot: AdmissionSlotKey; ref: HostRef; generation: number }>
  | Readonly<{ kind: 'block'; slot: AdmissionSlotKey; ref: HostRef; generation: number }>
  | Readonly<{ kind: 'retired'; ref: HostRef }>
  | Readonly<{ kind: 'confirm-evicted'; ref: HostRef }>;

export function admissionSlotKey(value: string): AdmissionSlotKey {
  if (value.length === 0) throw new Error('provider_host_admission_slot_invalid: slot key must not be empty');
  return value as AdmissionSlotKey;
}

export function exactHostRefsMatch(left: HostRef, right: HostRef): boolean {
  if (
    left.provider !== right.provider ||
    left.fingerprint !== right.fingerprint ||
    left.instanceId !== right.instanceId ||
    left.leaseMode !== right.leaseMode
  ) {
    return false;
  }
  return left.leaseMode === 'shared' || (right.leaseMode === 'job-exclusive' && left.ownerJobId === right.ownerJobId);
}

export function reduceHostAdmission(state: HostAdmissionState, event: AdmissionEvent): HostAdmissionState {
  switch (event.kind) {
    case 'reserve':
      return reserveAdmissionCandidate(state, event.entry);
    case 'mark-live':
      return markAdmissionCandidateLive(state, event.slot, event.ref, event.generation);
    case 'block':
      return blockAdmissionCandidate(state, event.slot, event.ref, event.generation);
    case 'retired':
      return retireAdmissionCandidate(state, event.ref);
    case 'confirm-evicted':
      return confirmAdmissionCandidateEvicted(state, event.ref);
  }
}

function reserveAdmissionCandidate(state: HostAdmissionState, entry: AdmissionEntry): HostAdmissionState {
  return state.has(entry.slot) ? state : withEntry(state, entry.slot, entry);
}

function markAdmissionCandidateLive(
  state: HostAdmissionState,
  slot: AdmissionSlotKey,
  ref: HostRef,
  generation: number,
): HostAdmissionState {
  const current = matchingCandidate(state, slot, ref, generation);
  return current === null || current.phase !== 'spawning'
    ? state
    : withEntry(state, slot, Object.freeze({ ...current, phase: 'live' }));
}

function blockAdmissionCandidate(
  state: HostAdmissionState,
  slot: AdmissionSlotKey,
  ref: HostRef,
  generation: number,
): HostAdmissionState {
  const current = matchingCandidate(state, slot, ref, generation);
  if (current === null || current.phase === 'blocked-live' || current.phase === 'retired-blocked') return state;
  return withEntry(state, slot, Object.freeze({ ...current, phase: 'blocked-live' }));
}

function retireAdmissionCandidate(state: HostAdmissionState, ref: HostRef): HostAdmissionState {
  const match = findExactRef(state, ref);
  if (match === null || match.entry.phase === 'retired-blocked') return state;
  return match.entry.phase === 'blocked-live'
    ? withEntry(state, match.slot, Object.freeze({ ...match.entry, phase: 'retired-blocked' }))
    : withoutEntry(state, match.slot);
}

function confirmAdmissionCandidateEvicted(state: HostAdmissionState, ref: HostRef): HostAdmissionState {
  const match = findExactRef(state, ref);
  if (match === null || (match.entry.phase !== 'blocked-live' && match.entry.phase !== 'retired-blocked')) return state;
  return withoutEntry(state, match.slot);
}

type Placement = Readonly<{
  slot: AdmissionSlotKey;
  ref: HostRef;
  generation: number;
  spec: ProviderHostCanonicalSpecMetadata;
  host: ProviderHostCanonicalOwnerMetadata;
  inspectDiagnostics: () => ProviderHostDiagnosticsSnapshot;
}>;

export type HostAdmissionReservation = Readonly<{
  reserveCandidate(placement: Placement): void;
  markLive(ref: HostRef, generation: number): void;
  observeRetired(ref: HostRef, processState: HostProcessState): void;
}>;

export type HostAdmissionCollection = Readonly<{
  withFreshPlacement<Result>(
    slot: AdmissionSlotKey,
    delegate: (reservation: HostAdmissionReservation) => Promise<Result>,
  ): Promise<Result>;
  observe(slot: AdmissionSlotKey, ref: HostRef, fact: ProviderResponseDiagnosticFact): void;
  correlateTerminalFailure<Result>(ref: HostRef, operation: () => Promise<Result>): Promise<Result>;
  observeRetired(ref: HostRef, processState: HostProcessState): void;
  confirmEvicted(ref: HostRef): boolean;
  snapshot(): HostAdmissionSnapshot;
}>;

type HostAdmissionData = {
  state: HostAdmissionState;
  readonly placements: Map<AdmissionSlotKey, Placement>;
  readonly serviceability: Map<AdmissionSlotKey, HostServiceabilityState>;
};

type TombstoneRetention = Readonly<{
  retain(tombstone: ProviderHostTombstone): void;
  delete(slot: AdmissionSlotKey): void;
  snapshot(): readonly ProviderHostTombstone[];
}>;

type ReservationSerializer = Readonly<{
  run<Result>(slot: AdmissionSlotKey, operation: () => Promise<Result>): Promise<Result>;
}>;

export function createHostAdmissionCollection(options: {
  classify(provider: string, fact: ProviderResponseDiagnosticFact): HostServiceability;
}): HostAdmissionCollection {
  const data: HostAdmissionData = {
    state: new Map(),
    placements: new Map(),
    serviceability: new Map(),
  };
  const tombstones = createTombstoneRetention();
  const reservations = createReservationSerializer();

  const observeRetired = (ref: HostRef, processState: HostProcessState): void => {
    observeHostRetirement(data, tombstones, ref, processState);
  };

  return Object.freeze({
    withFreshPlacement: (slot, delegate) =>
      reservations.run(slot, () => {
        assertFreshPlacementAllowed(data.state, slot);
        return delegate(reservationFor(data, slot, observeRetired));
      }),
    observe(slot, ref, fact) {
      observeProviderResponse(data, options.classify, slot, ref, fact);
    },
    async correlateTerminalFailure(ref, operation) {
      try {
        return await operation();
      } catch (error: unknown) {
        const match = findExactRef(data.state, ref);
        if (match !== null && hostAdmissionForPhase(match.entry.phase) === 'blocked') {
          throw new ProviderHostUnserviceableResponseError(match.entry.ref, error);
        }
        throw error;
      }
    },
    observeRetired,
    confirmEvicted(ref) {
      return confirmHostEvicted(data, tombstones, ref);
    },
    snapshot() {
      return Object.freeze({
        state: new Map(data.state),
        tombstones: tombstones.snapshot(),
      });
    },
  });
}

function reservationFor(
  data: HostAdmissionData,
  slot: AdmissionSlotKey,
  observeRetired: HostAdmissionReservation['observeRetired'],
): HostAdmissionReservation {
  return Object.freeze({
    reserveCandidate(placement) {
      if (placement.slot !== slot) {
        throw new Error('provider_host_admission_slot_mismatch: reservation used for a different slot');
      }
      const entry: AdmissionEntry = Object.freeze({
        slot,
        ref: freezeHostRef(placement.ref),
        generation: placement.generation,
        phase: 'spawning',
      });
      const next = reduceHostAdmission(data.state, { kind: 'reserve', entry });
      if (next === data.state) {
        throw new Error('provider_host_admission_reservation_conflict: slot already has a candidate');
      }
      data.state = next;
      data.placements.set(slot, freezePlacement(placement));
      const initial = reduceHostServiceability(undefined, {
        kind: 'instance-started',
        instanceId: placement.ref.instanceId,
      });
      if (initial !== undefined) data.serviceability.set(slot, initial);
    },
    markLive(ref, generation) {
      data.state = reduceHostAdmission(data.state, { kind: 'mark-live', slot, ref, generation });
    },
    observeRetired,
  });
}

function assertFreshPlacementAllowed(state: HostAdmissionState, slot: AdmissionSlotKey): void {
  const current = state.get(slot);
  if (current !== undefined && hostAdmissionForPhase(current.phase) === 'blocked') {
    throw new ProviderHostUnserviceableError(current.ref);
  }
}

function observeProviderResponse(
  data: HostAdmissionData,
  classify: (provider: string, fact: ProviderResponseDiagnosticFact) => HostServiceability,
  slot: AdmissionSlotKey,
  ref: HostRef,
  fact: ProviderResponseDiagnosticFact,
): void {
  const current = matchingCandidate(data.state, slot, ref, fact.generation);
  const placement = data.placements.get(slot);
  if (current === null || placement === undefined || !exactHostRefsMatch(placement.ref, ref)) return;
  const serviceability = classify(placement.spec.provider, fact);
  const next = reduceHostServiceability(data.serviceability.get(slot), {
    kind: 'finding',
    instanceId: ref.instanceId,
    serviceability,
  });
  if (next === undefined) return;
  data.serviceability.set(slot, next);
  if (next.serviceability === 'unserviceable') {
    data.state = reduceHostAdmission(data.state, { kind: 'block', slot, ref, generation: fact.generation });
  }
}

function observeHostRetirement(
  data: HostAdmissionData,
  tombstones: TombstoneRetention,
  ref: HostRef,
  processState: HostProcessState,
): void {
  if (processState !== 'closed') return;
  const match = findExactRef(data.state, ref);
  if (match === null) return;
  const placement = data.placements.get(match.slot);
  const next = reduceHostAdmission(data.state, { kind: 'retired', ref });
  const retired = next.get(match.slot);
  if (retired?.phase === 'retired-blocked' && placement !== undefined) {
    tombstones.retain(tombstoneFor(retired, placement));
  }
  data.state = next;
  if (retired?.phase !== 'retired-blocked') {
    data.placements.delete(match.slot);
    data.serviceability.delete(match.slot);
  }
}

function confirmHostEvicted(data: HostAdmissionData, tombstones: TombstoneRetention, ref: HostRef): boolean {
  const before = data.state;
  const match = findExactRef(before, ref);
  data.state = reduceHostAdmission(before, { kind: 'confirm-evicted', ref });
  if (data.state === before || match === null) return false;
  data.placements.delete(match.slot);
  data.serviceability.delete(match.slot);
  tombstones.delete(match.slot);
  return true;
}

function createReservationSerializer(): ReservationSerializer {
  const reservations = new Map<AdmissionSlotKey, Promise<void>>();

  const run = async <Result>(slot: AdmissionSlotKey, operation: () => Promise<Result>): Promise<Result> => {
    const preceding = reservations.get(slot);
    if (preceding !== undefined) {
      await preceding;
      return run(slot, operation);
    }

    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    reservations.set(slot, turn);
    const finish = (): void => {
      if (reservations.get(slot) === turn) reservations.delete(slot);
      release();
    };

    try {
      const result = operation();
      void result.then(finish, finish);
      return result;
    } catch (error: unknown) {
      finish();
      throw error;
    }
  };

  return Object.freeze({ run });
}

function createTombstoneRetention(): TombstoneRetention {
  const tombstones = new Map<AdmissionSlotKey, ProviderHostTombstone>();
  return Object.freeze({
    retain(tombstone) {
      tombstones.set(tombstone.slot, tombstone);
      rebalanceTombstoneDiagnostics(tombstones);
    },
    delete(slot) {
      tombstones.delete(slot);
    },
    snapshot() {
      return Object.freeze([...tombstones.values()]);
    },
  });
}

export function canonicalProviderHostSpecMetadata(spec: ProviderServerSpec): ProviderHostCanonicalSpecMetadata {
  return Object.freeze({
    provider: spec.provider,
    command: spec.command,
    args: Object.freeze([...spec.args]),
    cwd: spec.cwd ?? null,
    leaseMode: spec.leaseMode,
    idleRetirement: spec.leaseMode === 'shared' ? spec.idleRetirement : null,
  });
}

function matchingCandidate(
  state: HostAdmissionState,
  slot: AdmissionSlotKey,
  ref: HostRef,
  generation: number,
): AdmissionEntry | null {
  const current = state.get(slot);
  return current !== undefined && current.generation === generation && exactHostRefsMatch(current.ref, ref)
    ? current
    : null;
}

function findExactRef(
  state: HostAdmissionState,
  ref: HostRef,
): Readonly<{ slot: AdmissionSlotKey; entry: AdmissionEntry }> | null {
  for (const [slot, entry] of state) {
    if (exactHostRefsMatch(entry.ref, ref)) return { slot, entry };
  }
  return null;
}

function withEntry(state: HostAdmissionState, slot: AdmissionSlotKey, entry: AdmissionEntry): HostAdmissionState {
  const next = new Map(state);
  next.set(slot, entry);
  return next;
}

function withoutEntry(state: HostAdmissionState, slot: AdmissionSlotKey): HostAdmissionState {
  const next = new Map(state);
  next.delete(slot);
  return next;
}

function freezeHostRef(ref: HostRef): HostRef {
  return Object.freeze({ ...ref });
}

function freezePlacement(placement: Placement): Placement {
  return Object.freeze({
    ...placement,
    ref: freezeHostRef(placement.ref),
    spec: deepFreeze(structuredClone(placement.spec)),
    host: deepFreeze(structuredClone(placement.host)),
  });
}

function tombstoneFor(entry: AdmissionEntry, placement: Placement): ProviderHostTombstone {
  return Object.freeze({
    slot: entry.slot,
    ref: freezeHostRef(entry.ref),
    generation: entry.generation,
    phase: 'retired-blocked',
    spec: placement.spec,
    host: placement.host,
    retirement: Object.freeze({ status: 'retired', processAbsent: true }),
    diagnostics: freezeDiagnostics(placement.inspectDiagnostics()),
    diagnosticsRetention: Object.freeze({ ownerBudgetTruncated: false }),
  });
}

function rebalanceTombstoneDiagnostics(tombstones: Map<AdmissionSlotKey, ProviderHostTombstone>): void {
  let remainingBytes = PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET;
  let remainingFacts = PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_FACT_BUDGET;
  const entries = [...tombstones.entries()].reverse();
  for (const [slot, tombstone] of entries) {
    const bounded = boundDiagnostics(tombstone.diagnostics, remainingBytes, remainingFacts);
    const bytes = diagnosticsBytes(bounded.snapshot);
    remainingBytes = Math.max(0, remainingBytes - bytes);
    remainingFacts = Math.max(0, remainingFacts - bounded.snapshot.completedObservations.length);
    if (bounded.truncated || tombstone.diagnosticsRetention.ownerBudgetTruncated) {
      tombstones.set(
        slot,
        Object.freeze({
          ...tombstone,
          diagnostics: bounded.snapshot,
          diagnosticsRetention: Object.freeze({ ownerBudgetTruncated: true }),
        }),
      );
    }
  }
}

function boundDiagnostics(
  input: ProviderHostDiagnosticsSnapshot,
  maxBytes: number,
  maxFacts: number,
): Readonly<{ snapshot: ProviderHostDiagnosticsSnapshot; truncated: boolean }> {
  let entries = [...input.hostLog.entries];
  let facts = [...input.completedObservations].slice(-maxFacts);
  let truncated = facts.length !== input.completedObservations.length;
  let snapshot = diagnosticSnapshot(input, entries, facts, truncated);

  while (diagnosticsBytes(snapshot) > maxBytes && entries.length > 0) {
    entries.shift();
    truncated = true;
    snapshot = diagnosticSnapshot(input, entries, facts, true);
  }
  while (diagnosticsBytes(snapshot) > maxBytes && facts.length > 0) {
    facts.shift();
    truncated = true;
    snapshot = diagnosticSnapshot(input, entries, facts, true);
  }
  if (diagnosticsBytes(snapshot) > maxBytes) {
    entries = [];
    facts = [];
    truncated = true;
    snapshot = diagnosticSnapshot(input, entries, facts, true);
  }
  return Object.freeze({ snapshot, truncated });
}

function diagnosticSnapshot(
  input: ProviderHostDiagnosticsSnapshot,
  entries: readonly ProviderHostLogEntry[],
  facts: readonly InspectedProviderResponseDiagnosticFact[],
  ownerTruncated: boolean,
): ProviderHostDiagnosticsSnapshot {
  const frozenEntries = Object.freeze(entries.map((entry) => deepFreeze(structuredClone(entry))));
  const firstEntrySeq = frozenEntries[0]?.seq;
  const truncatedBeforeSeq = ownerTruncated
    ? Math.max(input.hostLog.truncatedBeforeSeq, firstEntrySeq ?? lastLogSeq(input) + 1)
    : input.hostLog.truncatedBeforeSeq;
  const completedObservations = Object.freeze(
    facts.map((fact) => {
      const hostLog = Object.freeze({
        startSeq: fact.hostLog.startSeq,
        endSeq: fact.hostLog.endSeq,
        truncated:
          ownerTruncated ||
          fact.hostLog.truncated ||
          fact.hostLog.startSeq < truncatedBeforeSeq ||
          fact.hostLog.endSeq < truncatedBeforeSeq,
        historical: Object.freeze(frozenEntries.filter((entry) => entry.seq <= fact.hostLog.startSeq)),
        during: Object.freeze(
          frozenEntries.filter((entry) => fact.hostLog.startSeq < entry.seq && entry.seq <= fact.hostLog.endSeq),
        ),
        after: Object.freeze(frozenEntries.filter((entry) => entry.seq > fact.hostLog.endSeq)),
      });
      return deepFreeze({
        factSeq: fact.factSeq,
        generation: fact.generation,
        requestId: fact.requestId,
        method: fact.method,
        response: structuredClone(fact.response),
        hostLog,
      });
    }),
  );
  const firstFactSeq = completedObservations[0]?.factSeq;
  return Object.freeze({
    hostLog: Object.freeze({
      entries: frozenEntries,
      retainedBytes: frozenEntries.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0),
      truncatedBeforeSeq,
    }),
    completedObservations,
    factsTruncatedBeforeSeq: ownerTruncated
      ? Math.max(input.factsTruncatedBeforeSeq, firstFactSeq ?? lastFactSeq(input) + 1)
      : input.factsTruncatedBeforeSeq,
  });
}

function lastLogSeq(snapshot: ProviderHostDiagnosticsSnapshot): number {
  return snapshot.hostLog.entries.at(-1)?.seq ?? snapshot.hostLog.truncatedBeforeSeq;
}

function lastFactSeq(snapshot: ProviderHostDiagnosticsSnapshot): number {
  return snapshot.completedObservations.at(-1)?.factSeq ?? snapshot.factsTruncatedBeforeSeq;
}

function diagnosticsBytes(snapshot: ProviderHostDiagnosticsSnapshot): number {
  const logBytes = snapshot.hostLog.entries.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'),
    0,
  );
  const factBytes = snapshot.completedObservations.reduce(
    (total, fact) => total + Buffer.byteLength(JSON.stringify(fact), 'utf8'),
    0,
  );
  return logBytes + factBytes;
}

function freezeDiagnostics(snapshot: ProviderHostDiagnosticsSnapshot): ProviderHostDiagnosticsSnapshot {
  return deepFreeze(structuredClone(snapshot));
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
