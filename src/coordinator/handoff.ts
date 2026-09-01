// Coordinator-side bind/escalation state machine. Sits above transport's
// `requestIncumbentShutdown`: speaks IPC for graceful handoff, polls
// bindability, and only signals (SIGTERM → SIGKILL) after revalidating the
// incumbent's pid+incarnation against the kernel.
//
// All time/process/env access flows through `runtime` ports per the Single
// Runtime World rule.

import { join } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { incarnationMayAuthorizeSignal, isProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { backendLog } from '../infra/backend-log.js';
import { HANDOFF_SIGNAL_POLICY_ENV, SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { IdPort, Runtime } from '../runtime/ports.js';
import {
  CoralSetupError,
  renderHandoffRefusal,
  type HandoffRefusalCode,
  type HandoffRefusalInit,
  type HandoffVerificationContext,
  type MissingSignalCapabilityField,
} from '../runtime/errors.js';
import type { StoragePort } from '../infra/port-types.js';
import type { RunStartupRecoveryFn, RunStartupRecoveryOrchestratorFn } from './lifecycle.js';
import type { RunCoordinatorStartupRecoveryFn } from './services/recovery/index.js';
import {
  requestIncumbentShutdown,
  type DesiredIncumbentIdentity,
  type IncumbentHealth,
  type IncumbentIdentity,
} from '../transport/ipc/handoff.js';

const SOCKET_BIND_POLL_MS = 200;
const SHUTDOWN_RPC_TIMEOUT_MS = 1_000;
const DEFAULT_SIGNAL_COOLDOWN_MS = 60_000;
const LEGACY_SIGNAL_LEDGER_FILE = 'handoff-signal.json';

export class HandoffEscalationError extends CoralSetupError {
  constructor(init: HandoffRefusalInit, options?: ErrorOptions) {
    super(renderHandoffRefusal(init), options);
    this.name = 'HandoffEscalationError';
  }
}

/**
 * Raised when the contender discovers the incumbent already serves the same
 * version/bundle/flavor/namespace and is therefore not a candidate for replacement.
 * Bootstrap translates this into an info-log + `exit 0` (the contender is
 * redundant; the existing daemon stays).
 */
export class BackendAlreadyRunningError extends Error {
  constructor() {
    super('Coral backend already running');
    this.name = 'BackendAlreadyRunningError';
  }
}

export type HandoffBindResult =
  | { kind: 'bound' }
  | { kind: 'incumbent'; reason: string }
  | { kind: 'addressed-incumbent'; socketPath: string };

export type BoundCoordinator = Readonly<{
  readonly acquiredViaHandoff: boolean;
  readonly runStartupRecovery: RunStartupRecoveryFn;
}>;

type BoundCoordinatorState = {
  runCoordinatorStartupRecovery: RunCoordinatorStartupRecoveryFn | null;
};

const boundCoordinatorStates = new WeakMap<object, BoundCoordinatorState>();

export function registerCoordinatorStartupRecovery(
  bound: BoundCoordinator,
  runCoordinatorStartupRecovery: RunCoordinatorStartupRecoveryFn,
): void {
  const state = boundCoordinatorStates.get(bound);
  if (state === undefined) {
    throw new Error('Bound coordinator capability is not registered');
  }
  if (state.runCoordinatorStartupRecovery !== null) {
    throw new Error('Bound coordinator startup recovery is already registered');
  }
  state.runCoordinatorStartupRecovery = runCoordinatorStartupRecovery;
}

export type HandoffSignalPolicy = 'term-kill' | 'term-only' | 'manual';

export interface HandoffOptions {
  socketPath: string;
  desired: DesiredIncumbentIdentity;
  bindAttempt: () => Promise<HandoffBindResult>;
  runStartupRecovery: RunStartupRecoveryOrchestratorFn;
  runtime: Pick<Runtime, 'time' | 'process' | 'env'>;
  /**
   * Read `coordinator.json` and cross-check it against the bound socket and
   * the most recent IPC health evidence. Returns null if the discovery
   * record is missing, doesn't match `socketPath`/flavor/namespace, or
   * contradicts the health snapshot we obtained from the same socket.
   */
  readVerifiedIncumbentFromDiscovery: (evidence: {
    socketPath: string;
    desired: DesiredIncumbentIdentity;
    lastHealth: IncumbentHealth | null;
  }) => IncumbentIdentity | null;
  signalLedger?: HandoffSignalLedger;
  signalCooldownMs?: number;
  signalPolicy?: HandoffSignalPolicy;
  signal?: AbortSignal;
  totalBudgetMs: number;
}

type HandoffSignal = 'SIGTERM' | 'SIGKILL';
type HandoffSignalResult = 'accepted' | 'rejected';

const HANDOFF_SIGNAL_RECORD_VERSION = 2 as const;
const SIGNAL_LEDGER_FILE = `handoff-signal.v${HANDOFF_SIGNAL_RECORD_VERSION}.json`;

export type HandoffSignalRecord = {
  version: typeof HANDOFF_SIGNAL_RECORD_VERSION;
  accepted: true;
  socketPath: string;
  pid: number;
  incarnation?: ProcessIncarnation;
  instanceId?: string;
  signal: HandoffSignal;
  signaledAtMs: number;
  publicationId?: string;
};

export type LegacyHandoffSignalAttemptRecord = Omit<HandoffSignalRecord, 'accepted' | 'version'> & {
  version: 1;
  accepted?: never;
};

type HandoffSignalShadowRecord = Omit<HandoffSignalRecord, 'version'> & {
  version: 1;
};

type HandoffSignalLedgerRecord = HandoffSignalRecord | HandoffSignalShadowRecord | LegacyHandoffSignalAttemptRecord;

type HandoffSignalLedgerCandidate = Readonly<{
  address: 'detail' | 'shadow';
  provenance: 'detail-publication' | 'paired-shadow' | 'foreign-publication';
  record: HandoffSignalLedgerRecord;
}>;

export type HandoffSignalCooldownDisposition =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{
      kind: 'accepted-signal';
      signal: HandoffSignal;
      ageMs: number;
      retryInMs: number;
    }>
  | Readonly<{
      kind: 'foreign-signal-attempt';
      signal: HandoffSignal;
      ageMs: number;
      retryInMs: number;
    }>;

export interface HandoffSignalLedger {
  cooldownDisposition(input: {
    socketPath: string;
    incumbent: IncumbentIdentity;
    nowMs: number;
    cooldownMs: number;
  }): HandoffSignalCooldownDisposition;
  write(record: HandoffSignalRecord): void;
}

type HandoffSignalLedgerStorage = Pick<StoragePort, 'mkdirSync' | 'readFileSync' | 'writeAtomicSync'>;

export function createFileHandoffSignalLedger(options: {
  storage: HandoffSignalLedgerStorage;
  ids: IdPort;
  runDir: string;
}): HandoffSignalLedger {
  const path = join(options.runDir, SIGNAL_LEDGER_FILE);
  const legacyPath = join(options.runDir, LEGACY_SIGNAL_LEDGER_FILE);
  const readAt = (
    recordPath: string,
    version: HandoffSignalLedgerRecord['version'],
  ): HandoffSignalLedgerRecord | null => {
    try {
      const parsed = JSON.parse(options.storage.readFileSync(recordPath, 'utf-8')) as unknown;
      const record = decodeHandoffSignalLedgerRecord(parsed);
      return record?.version === version ? record : null;
    } catch {
      return null;
    }
  };
  const writeAt = (recordPath: string, record: HandoffSignalLedgerRecord): boolean => {
    try {
      options.storage.writeAtomicSync(recordPath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      return true;
    } catch {
      // Ledger persistence must fail open so a verified incumbent cannot become permanently unreplaceable.
      return false;
    }
  };
  return {
    cooldownDisposition: ({ socketPath, incumbent, nowMs, cooldownMs }) => {
      const current = readAt(path, HANDOFF_SIGNAL_RECORD_VERSION);
      const legacy = readAt(legacyPath, 1);
      const matchingCurrent = current !== null && isSameSignalTarget(current, socketPath, incumbent) ? current : null;
      const matchingLegacy = legacy !== null && isSameSignalTarget(legacy, socketPath, incumbent) ? legacy : null;
      const paired =
        matchingCurrent !== null &&
        matchingLegacy !== null &&
        matchingCurrent.publicationId !== undefined &&
        matchingCurrent.publicationId === matchingLegacy.publicationId;
      const candidates: HandoffSignalLedgerCandidate[] = [
        ...(matchingCurrent === null
          ? []
          : [{ address: 'detail', provenance: 'detail-publication', record: matchingCurrent } as const]),
        ...(matchingLegacy === null
          ? []
          : [
              {
                address: 'shadow',
                provenance: paired ? 'paired-shadow' : 'foreign-publication',
                record: matchingLegacy,
              } as const,
            ]),
      ];
      const independent = candidates.filter((candidate) => candidate.provenance !== 'paired-shadow');
      const active = independent.filter((candidate) => nowMs - candidate.record.signaledAtMs < cooldownMs);
      active.sort((left, right) => {
        const recency = right.record.signaledAtMs - left.record.signaledAtMs;
        if (recency !== 0) return recency;
        const leftIsIndeterminate = left.record.version === 1 && left.record.accepted !== true;
        const rightIsIndeterminate = right.record.version === 1 && right.record.accepted !== true;
        return Number(rightIsIndeterminate) - Number(leftIsIndeterminate);
      });
      const selectedCandidate = active[0];
      if (selectedCandidate === undefined) return { kind: 'clear' };
      const selected = selectedCandidate.record;
      const ageMs = nowMs - selected.signaledAtMs;
      const timing = { signal: selected.signal, ageMs, retryInMs: cooldownMs - ageMs };
      return selected.version === 1 && selected.accepted !== true
        ? { kind: 'foreign-signal-attempt', ...timing }
        : { kind: 'accepted-signal', ...timing };
    },
    write: (record) => {
      try {
        options.storage.mkdirSync(options.runDir, { recursive: true });
      } catch {
        return;
      }
      const publicationId = options.ids.uuid();
      const shadowWritten = writeAt(legacyPath, {
        version: 1,
        accepted: true,
        socketPath: record.socketPath,
        pid: record.pid,
        ...(record.incarnation === undefined ? {} : { incarnation: record.incarnation }),
        ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId }),
        signal: record.signal,
        signaledAtMs: record.signaledAtMs,
        publicationId,
      });
      if (!shadowWritten) {
        return;
      }
      writeAt(path, { ...record, publicationId });
    },
  };
}

function decodeHandoffSignalLedgerRecord(value: unknown): HandoffSignalLedgerRecord | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const commonShapeIsValid =
    typeof record.socketPath === 'string' &&
    Number.isInteger(record.pid) &&
    (record.incarnation === undefined || isProcessIncarnation(record.incarnation)) &&
    (record.instanceId === undefined || typeof record.instanceId === 'string') &&
    (record.signal === 'SIGTERM' || record.signal === 'SIGKILL') &&
    Number.isFinite(record.signaledAtMs) &&
    (record.publicationId === undefined ||
      (typeof record.publicationId === 'string' && record.publicationId.length > 0));
  if (!commonShapeIsValid) {
    return null;
  }
  if (record.version === 1) {
    return record.accepted === true
      ? (record as HandoffSignalShadowRecord)
      : (record as LegacyHandoffSignalAttemptRecord);
  }
  return record.version === HANDOFF_SIGNAL_RECORD_VERSION && record.accepted === true
    ? (record as HandoffSignalRecord)
    : null;
}

function sameIncumbent(left: IncumbentIdentity, right: IncumbentIdentity): boolean {
  if (left.pid !== right.pid) {
    return false;
  }
  if (left.incarnation !== undefined && right.incarnation !== undefined && left.incarnation !== right.incarnation) {
    return false;
  }
  if (left.instanceId !== undefined && left.instanceId !== right.instanceId) {
    return false;
  }
  if (left.token !== undefined && left.token !== right.token) {
    return false;
  }
  if (left.bootToken !== undefined && left.bootToken !== right.bootToken) {
    return false;
  }
  return true;
}

type DiscoveryMergeResult =
  | { kind: 'merged'; incumbent: IncumbentIdentity | null }
  | { kind: 'changed'; fresh: IncumbentIdentity };

function mergeVerifiedDiscovery(
  current: IncumbentIdentity | null,
  fresh: IncumbentIdentity | null,
): DiscoveryMergeResult {
  if (fresh === null) {
    return { kind: 'merged', incumbent: current };
  }
  if (current !== null && !sameIncumbent(current, fresh)) {
    return { kind: 'changed', fresh };
  }
  return { kind: 'merged', incumbent: fresh };
}

function readFreshDiscovery(opts: HandoffOptions, lastHealth: IncumbentHealth | null): IncumbentIdentity | null {
  return opts.readVerifiedIncumbentFromDiscovery({
    socketPath: opts.socketPath,
    desired: opts.desired,
    lastHealth,
  });
}

function refreshIncumbentForSignal(
  opts: HandoffOptions,
  incumbent: IncumbentIdentity,
  lastHealth: IncumbentHealth | null,
  context: HandoffVerificationContext,
): IncumbentIdentity {
  const fresh = readFreshDiscovery(opts, lastHealth);
  if (fresh === null) {
    throw new HandoffEscalationError({
      code: 'handoff_fresh_discovery_unavailable',
      context,
    });
  }
  if (!sameIncumbent(incumbent, fresh)) {
    throw new HandoffEscalationError({
      code: 'handoff_fresh_discovery_changed',
      context,
    });
  }
  return fresh;
}

function missingSignalCapabilityFields(incumbent: IncumbentIdentity): MissingSignalCapabilityField[] {
  const missing: MissingSignalCapabilityField[] = [];
  if (incumbent.instanceId === undefined || incumbent.instanceId.length === 0) {
    missing.push('instanceId');
  }
  if (incumbent.token === undefined || incumbent.token.length === 0) {
    missing.push('token');
  }
  if (incumbent.bootToken === undefined || incumbent.bootToken.length === 0) {
    missing.push('bootToken');
  }
  return missing;
}

function assertSignalCapability(incumbent: IncumbentIdentity, context: HandoffVerificationContext): void {
  const missing = missingSignalCapabilityFields(incumbent);
  if (missing.length === 0) {
    return;
  }
  throw new HandoffEscalationError({
    code: 'handoff_signal_capability_unavailable',
    context: { ...context, missingFields: missing },
  });
}

function isSameSignalTarget(
  record: HandoffSignalLedgerRecord,
  socketPath: string,
  incumbent: IncumbentIdentity,
): boolean {
  return (
    record.socketPath === socketPath &&
    record.pid === incumbent.pid &&
    (record.incarnation === undefined ||
      incumbent.incarnation === undefined ||
      record.incarnation === incumbent.incarnation) &&
    (record.instanceId === undefined || record.instanceId === incumbent.instanceId)
  );
}

function assertSignalCooldown(opts: HandoffOptions, incumbent: IncumbentIdentity, signal: HandoffSignal): void {
  const ledger = opts.signalLedger;
  if (ledger === undefined) {
    return;
  }
  const cooldownMs = opts.signalCooldownMs ?? DEFAULT_SIGNAL_COOLDOWN_MS;
  const disposition = ledger.cooldownDisposition({
    socketPath: opts.socketPath,
    incumbent,
    nowMs: opts.runtime.time.now(),
    cooldownMs,
  });
  if (disposition.kind === 'clear') return;
  if (disposition.kind === 'foreign-signal-attempt') {
    throw new HandoffEscalationError({
      code: 'handoff_legacy_signal_attempt_indeterminate',
      context: {
        stage: 'before-signal',
        pid: incumbent.pid,
        requestedSignal: signal,
        previousSignal: disposition.signal,
        ageMs: disposition.ageMs,
        retryInMs: disposition.retryInMs,
      },
    });
  }
  throw new HandoffEscalationError({
    code: 'handoff_signal_cooldown_active',
    context: {
      stage: 'before-signal',
      pid: incumbent.pid,
      requestedSignal: signal,
      previousSignal: disposition.signal,
      ageMs: disposition.ageMs,
      retryInMs: disposition.retryInMs,
    },
  });
}

function recordSignal(
  opts: HandoffOptions,
  incumbent: IncumbentIdentity,
  signal: HandoffSignal,
  acceptedAtMs: number,
): void {
  opts.signalLedger?.write({
    version: HANDOFF_SIGNAL_RECORD_VERSION,
    accepted: true,
    socketPath: opts.socketPath,
    pid: incumbent.pid,
    ...(incumbent.incarnation === undefined ? {} : { incarnation: incumbent.incarnation }),
    ...(incumbent.instanceId === undefined ? {} : { instanceId: incumbent.instanceId }),
    signal,
    signaledAtMs: acceptedAtMs,
  });
}

function signalErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contenderPid(env: Runtime['env']): number | undefined {
  try {
    const pid = (env as { pid?: () => number }).pid?.();
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function logHandoffSignalAudit(
  opts: HandoffOptions,
  incumbent: IncumbentIdentity,
  signal: HandoffSignal,
  result: HandoffSignalResult,
  error?: unknown,
): void {
  const currentContenderPid = contenderPid(opts.runtime.env);
  const payload = {
    signal,
    result,
    socketPath: opts.socketPath,
    desired: opts.desired,
    target: {
      pid: incumbent.pid,
      ...(incumbent.incarnation === undefined ? {} : { incarnation: incumbent.incarnation }),
      ...(incumbent.instanceId === undefined ? {} : { instanceId: incumbent.instanceId }),
    },
    ...(currentContenderPid === undefined ? {} : { contenderPid: currentContenderPid }),
    attemptedAtMs: opts.runtime.time.now(),
    ...(error === undefined ? {} : { error: signalErrorMessage(error) }),
  };
  writeAuditEvent('handoff_signal', payload, signal === 'SIGKILL' || result === 'rejected' ? 'error' : 'warn');
}

function signalIncumbent(
  opts: HandoffOptions,
  incumbent: IncumbentIdentity,
  signal: HandoffSignal,
): HandoffSignalResult {
  let result: HandoffSignalResult;
  let signalError: unknown;
  try {
    // A successful kill(2) return proves only kernel acceptance; it cannot prove that the target dequeued
    // the signal, ran a handler, or exited, including while the target is in uninterruptible sleep.
    result = opts.runtime.process.kill(incumbent.pid, signal) ? 'accepted' : 'rejected';
  } catch (error: unknown) {
    result = 'rejected';
    signalError = error;
  }
  logHandoffSignalAudit(opts, incumbent, signal, result, signalError);
  return result;
}

function readEnvSignalPolicy(env: Runtime['env']): HandoffSignalPolicy | undefined {
  const getter = (env as { get?: (key: string) => string | undefined }).get;
  const raw = getter?.call(env, HANDOFF_SIGNAL_POLICY_ENV)?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (raw === 'term-kill' || raw === 'default' || raw === 'signal') {
    return 'term-kill';
  }
  if (raw === 'term-only' || raw === 'sigterm-only') {
    return 'term-only';
  }
  if (raw === 'manual' || raw === 'none' || raw === 'off') {
    return 'manual';
  }
  return undefined;
}

function resolveSignalPolicy(opts: HandoffOptions): HandoffSignalPolicy {
  return opts.signalPolicy ?? readEnvSignalPolicy(opts.runtime.env) ?? 'term-kill';
}

async function sleepForHandoffPoll(opts: HandoffOptions, ms: number): Promise<void> {
  opts.signal?.throwIfAborted();
  await opts.runtime.time.sleep(Math.max(0, ms), opts.signal === undefined ? undefined : { signal: opts.signal });
  opts.signal?.throwIfAborted();
}

type SignalVerificationResult = 'alive' | 'gone';

const SIGNAL_TARGET_GONE: Readonly<{ kind: 'gone' }> = { kind: 'gone' };
const SIGNAL_TARGET_ALIVE: Readonly<{ kind: 'alive' }> = { kind: 'alive' };

function unverifiableSignalTarget<Code extends HandoffRefusalCode>(
  code: Code,
): Readonly<{
  kind: 'unverifiable';
  code: Code;
}> {
  return { kind: 'unverifiable', code };
}

type SignalTargetObservation = ReturnType<typeof observeSignalTarget>;
type SignalTargetRefusal = Extract<SignalTargetObservation, { kind: 'unverifiable' }>;

function refuseUnverifiableSignalTarget(
  refusal: SignalTargetRefusal,
  context: HandoffVerificationContext,
  options?: ErrorOptions,
): never {
  const { code } = refusal;
  switch (code) {
    case 'handoff_process_identity_unavailable':
      throw new HandoffEscalationError({ code, context }, options);
    case 'handoff_platform_identity_insufficient':
      throw new HandoffEscalationError({ code, context }, options);
    case 'handoff_published_incarnation_missing':
      throw new HandoffEscalationError({ code, context }, options);
    case 'handoff_published_incarnation_mismatch':
      throw new HandoffEscalationError({ code, context }, options);
    case 'handoff_signal_anchor_missing':
      throw new HandoffEscalationError({ code, context }, options);
    case 'handoff_pid_recycled':
      throw new HandoffEscalationError({ code, context }, options);
    case 'handoff_process_liveness_unknown':
      throw new HandoffEscalationError({ code, context }, options);
  }
  return code;
}

/**
 * Confirms the pid about to be signalled is still the process this attempt observed, by comparing two
 * probes **this contender made itself**.
 *
 * Two baselines, because they answer different questions and only one of them predates this contender.
 *
 * The **incumbent's published incarnation** says which process the record is about. Without it the only
 * baseline is this contender's own first observation — and a pid recycled *before* that observation
 * anchors an unrelated process, which then matches itself forever.
 *
 * The **self-anchor**, taken when the peer was authenticated, says the pid has not been recycled since.
 * The published incarnation cannot answer that, because it is equally old.
 *
 * A pre-token incumbent therefore cannot be escalated to a signal at all. It can still be asked to stand
 * down over IPC, which is the ordinary path and needs no such proof, so an upgrade over a *responsive*
 * predecessor is unaffected. An unresponsive one ends in a diagnostic instead of a kill — deliberately, and
 * the asymmetry is the argument: refusing is recoverable by a person who can see which service owns the
 * port, while acting on an unproven pid is not recoverable by anyone.
 *
 * What is still not closed: the interval between this check and the `kill` a few statements later. Nothing
 * short of a pidfd can, and this narrows it from "since the incumbent booted" to "since this verification".
 */
function verifySignalTarget(
  incumbent: IncumbentIdentity,
  anchoredIncarnation: ProcessIncarnation | null,
  process: Pick<Runtime['process'], 'observeLiveness' | 'readProcessIncarnation'>,
  platform: NodeJS.Platform,
  context: HandoffVerificationContext,
): SignalVerificationResult {
  const observation = observeSignalTarget(incumbent, anchoredIncarnation, process, platform);
  return observation.kind === 'unverifiable' ? refuseUnverifiableSignalTarget(observation, context) : observation.kind;
}

function observeSignalTarget(
  incumbent: IncumbentIdentity,
  anchoredIncarnation: ProcessIncarnation | null,
  process: Pick<Runtime['process'], 'observeLiveness' | 'readProcessIncarnation'>,
  platform: NodeJS.Platform,
) {
  const liveIncarnation = process.readProcessIncarnation(incumbent.pid, platform);
  if (liveIncarnation === null) {
    // Unreadable is not gone. Only a pid that no longer exists is gone.
    return process.observeLiveness(incumbent.pid) === 'absent'
      ? SIGNAL_TARGET_GONE
      : unverifiableSignalTarget('handoff_process_identity_unavailable');
  }
  // An identity that two processes can share cannot authorize a signal or decide which process survived it.
  if (!incarnationMayAuthorizeSignal(platform)) {
    return unverifiableSignalTarget('handoff_platform_identity_insufficient');
  }
  if (incumbent.incarnation === undefined) {
    return unverifiableSignalTarget('handoff_published_incarnation_missing');
  }
  if (anchoredIncarnation !== null && liveIncarnation !== anchoredIncarnation) {
    return unverifiableSignalTarget('handoff_pid_recycled');
  }
  if (incumbent.incarnation !== liveIncarnation) {
    return unverifiableSignalTarget('handoff_published_incarnation_mismatch');
  }
  if (anchoredIncarnation === null) {
    return unverifiableSignalTarget('handoff_signal_anchor_missing');
  }
  switch (process.observeLiveness(incumbent.pid)) {
    case 'absent':
      return SIGNAL_TARGET_GONE;
    case 'alive':
      return SIGNAL_TARGET_ALIVE;
    case 'unknown':
      return unverifiableSignalTarget('handoff_process_liveness_unknown');
  }
}

function settleSignalAttempt(
  opts: HandoffOptions,
  incumbent: IncumbentIdentity,
  anchoredIncarnation: ProcessIncarnation | null,
  signal: HandoffSignal,
  result: HandoffSignalResult,
  platform: NodeJS.Platform,
  context: HandoffVerificationContext,
): 'accepted' | 'target-gone' {
  if (result === 'accepted') {
    return 'accepted';
  }
  const observation = observeSignalTarget(incumbent, anchoredIncarnation, opts.runtime.process, platform);
  if (observation.kind === 'gone') {
    return 'target-gone';
  }
  if (observation.kind === 'alive') {
    throw new HandoffEscalationError({
      code: 'handoff_signal_rejected_live',
      context: {
        stage: 'after-rejected-signal',
        pid: incumbent.pid,
        signal,
      },
    });
  }
  return refuseUnverifiableSignalTarget(observation, context);
}

type PendingSignalSettlement = Readonly<{
  signal: HandoffSignal;
  acceptedAtMs: number;
  target: IncumbentIdentity;
  anchoredIncarnation: ProcessIncarnation | null;
}>;

type SigkillGraceTransitionOutcome =
  | { kind: 'target-gone' }
  | { kind: 'target-alive' }
  | { kind: 'target-unverifiable'; refusal: SignalTargetRefusal };

function observePendingSignal(
  pending: PendingSignalSettlement,
  process: Pick<Runtime['process'], 'observeLiveness' | 'readProcessIncarnation'>,
  platform: NodeJS.Platform,
): SignalTargetObservation {
  return observeSignalTarget(pending.target, pending.anchoredIncarnation, process, platform);
}

function refuseAfterPendingSignalFailure(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  platform: NodeJS.Platform,
  error: unknown,
): never {
  const observation = observePendingSignal(pending, opts.runtime.process, platform);
  if (observation.kind === 'gone') {
    throw error;
  }
  const context: Extract<HandoffVerificationContext, { stage: 'after-accepted-signal-failure' }> = {
    stage: 'after-accepted-signal-failure',
    pid: pending.target.pid,
    signal: pending.signal,
  };
  if (observation.kind === 'alive') {
    throw new HandoffEscalationError(
      {
        code: 'handoff_accepted_signal_target_alive_after_failure',
        context,
      },
      { cause: error },
    );
  }
  return refuseUnverifiableSignalTarget(observation, context, { cause: error });
}

type SigtermGraceTransitionOutcome =
  | { kind: 'target-gone'; stage: 'after-sigterm' | 'before-sigkill' | 'after-rejected-sigkill'; pid: number }
  | { kind: 'target-unverifiable'; refusal: SignalTargetRefusal; pid: number }
  | { kind: 'sigkill-forbidden'; pid: number }
  | { kind: 'sigkill-accepted'; pending: PendingSignalSettlement };

function transitionAfterSigtermGrace(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  policy: HandoffSignalPolicy,
  lastHealth: IncumbentHealth | null,
  platform: NodeJS.Platform,
): SigtermGraceTransitionOutcome {
  const observation = observePendingSignal(pending, opts.runtime.process, platform);
  if (observation.kind === 'unverifiable') {
    return { kind: 'target-unverifiable', refusal: observation, pid: pending.target.pid };
  }
  if (observation.kind === 'gone') {
    return { kind: 'target-gone', stage: 'after-sigterm', pid: pending.target.pid };
  }
  if (policy === 'term-only') {
    return { kind: 'sigkill-forbidden', pid: pending.target.pid };
  }

  const afterSigtermGrace: Extract<HandoffVerificationContext, { stage: 'after-sigterm-grace' }> = {
    stage: 'after-sigterm-grace',
    pid: pending.target.pid,
    signal: 'SIGTERM',
    graceMs: SIGTERM_GRACE_MS,
  };
  const incumbent = refreshIncumbentForSignal(opts, pending.target, lastHealth, afterSigtermGrace);
  if (
    verifySignalTarget(incumbent, pending.anchoredIncarnation, opts.runtime.process, platform, afterSigtermGrace) ===
    'gone'
  ) {
    return { kind: 'target-gone', stage: 'before-sigkill', pid: incumbent.pid };
  }
  assertSignalCapability(incumbent, afterSigtermGrace);
  opts.signal?.throwIfAborted();
  const result = signalIncumbent(opts, incumbent, 'SIGKILL');
  if (
    settleSignalAttempt(opts, incumbent, pending.anchoredIncarnation, 'SIGKILL', result, platform, {
      stage: 'after-rejected-signal',
      pid: incumbent.pid,
      signal: 'SIGKILL',
    }) === 'target-gone'
  ) {
    return { kind: 'target-gone', stage: 'after-rejected-sigkill', pid: incumbent.pid };
  }
  const acceptedAtMs = opts.runtime.time.now();
  recordSignal(opts, incumbent, 'SIGKILL', acceptedAtMs);
  return {
    kind: 'sigkill-accepted',
    pending: {
      signal: 'SIGKILL',
      acceptedAtMs,
      target: incumbent,
      anchoredIncarnation: pending.anchoredIncarnation,
    },
  };
}

function transitionAfterSigkillGrace(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  platform: NodeJS.Platform,
): SigkillGraceTransitionOutcome {
  const observation = observePendingSignal(pending, opts.runtime.process, platform);
  switch (observation.kind) {
    case 'gone':
      return { kind: 'target-gone' };
    case 'alive':
      return { kind: 'target-alive' };
    case 'unverifiable':
      return { kind: 'target-unverifiable', refusal: observation };
  }
}

type ExpiredPendingSignalTransitionOutcome =
  | { kind: 'target-gone'; message: string }
  | { kind: 'sigkill-accepted'; pending: PendingSignalSettlement };

function settleBoundSocketAgainstPendingSignal(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  platform: NodeJS.Platform,
): void {
  const observation = observePendingSignal(pending, opts.runtime.process, platform);
  if (observation.kind === 'unverifiable') {
    refuseUnverifiableSignalTarget(observation, {
      stage: 'after-accepted-signal-bind',
      pid: pending.target.pid,
      signal: pending.signal,
    });
  }
  if (observation.kind === 'alive') {
    throw new HandoffEscalationError({
      code: 'handoff_accepted_signal_target_alive_after_bind',
      context: {
        stage: 'after-accepted-signal-bind',
        pid: pending.target.pid,
        signal: pending.signal,
      },
    });
  }
}

function advanceExpiredPendingSignal(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  policy: HandoffSignalPolicy,
  lastHealth: IncumbentHealth | null,
  platform: NodeJS.Platform,
): ExpiredPendingSignalTransitionOutcome {
  if (pending.signal === 'SIGKILL') {
    const disposition = transitionAfterSigkillGrace(opts, pending, platform);
    const afterSigkillGrace: Extract<HandoffVerificationContext, { stage: 'after-sigkill-grace' }> = {
      stage: 'after-sigkill-grace',
      pid: pending.target.pid,
      signal: 'SIGKILL',
      graceMs: SIGKILL_GRACE_MS,
    };
    if (disposition.kind === 'target-unverifiable') {
      refuseUnverifiableSignalTarget(disposition.refusal, afterSigkillGrace);
    }
    if (disposition.kind === 'target-gone') {
      throw new HandoffEscalationError({
        code: 'handoff_sigkill_grace_target_gone_socket_still_bound',
        context: afterSigkillGrace,
      });
    }
    throw new HandoffEscalationError({
      code: 'handoff_sigkill_grace_target_alive',
      context: afterSigkillGrace,
    });
  }

  const transition = transitionAfterSigtermGrace(opts, pending, policy, lastHealth, platform);
  if (transition.kind === 'target-unverifiable') {
    refuseUnverifiableSignalTarget(transition.refusal, {
      stage: 'after-sigterm-grace',
      pid: transition.pid,
      signal: 'SIGTERM',
      graceMs: SIGTERM_GRACE_MS,
    });
  }
  if (transition.kind === 'sigkill-forbidden') {
    throw new HandoffEscalationError({
      code: 'handoff_term_only_policy',
      context: {
        stage: 'after-sigterm-grace',
        pid: transition.pid,
        graceMs: SIGTERM_GRACE_MS,
        policy: 'term-only',
      },
    });
  }
  if (transition.kind === 'sigkill-accepted') {
    return transition;
  }
  const message =
    transition.stage === 'after-sigterm'
      ? `Kernel accepted SIGTERM for incumbent pid=${transition.pid}, its grace elapsed, and the target is gone; retrying bind`
      : transition.stage === 'before-sigkill'
        ? `Incumbent pid=${transition.pid} exited before SIGKILL; retrying bind`
        : `Incumbent pid=${transition.pid} was gone after rejected SIGKILL; retrying bind`;
  return { kind: 'target-gone', message };
}

function createBoundCoordinator(sawIncumbent: boolean, opts: HandoffOptions): BoundCoordinator {
  const state: BoundCoordinatorState = { runCoordinatorStartupRecovery: null };
  const bound: BoundCoordinator = Object.freeze({
    acquiredViaHandoff: sawIncumbent,
    runStartupRecovery: (inputs) => {
      if (state.runCoordinatorStartupRecovery === null) {
        throw new Error('Bound coordinator startup recovery is not registered');
      }
      return opts.runStartupRecovery(inputs, state.runCoordinatorStartupRecovery);
    },
  });
  boundCoordinatorStates.set(bound, state);
  return bound;
}

/**
 * A contender must not evict a same-version incumbent solely because their bundle hashes differ, and an
 * older contender must not evict a healthy newer incumbent.
 */
export async function bindWithHandoff(initialOptions: HandoffOptions): Promise<BoundCoordinator> {
  let opts = { ...initialOptions };
  const deadline = opts.runtime.time.now() + opts.totalBudgetMs;
  const platform = opts.runtime.env.platform() as NodeJS.Platform;
  const signalPolicy = resolveSignalPolicy(opts);
  let sawIncumbent = false;
  let incumbent: IncumbentIdentity | null = null;
  let lastHealth: IncumbentHealth | null = null;
  let pendingSignal: PendingSignalSettlement | null = null;
  /** This contender's own first observation of the incumbent's pid — see `verifySignalTarget`. */
  let signalAnchor: { pid: number; incarnation: ProcessIncarnation } | null = null;

  /** Take the baseline the moment this attempt adopts a pid, from discovery or from an authenticated
   *  handshake. Anchoring only on the authenticated case left the ordinary discovery-first path with no
   *  baseline until escalation, where the two probes are adjacent and prove nothing; anchoring only on
   *  first-adoption-ever would leave an incumbent that is bound but silent on IPC unescalatable. */
  const takeSignalAnchor = (pid: number): void => {
    if (signalAnchor?.pid === pid) {
      return;
    }
    const observed = opts.runtime.process.readProcessIncarnation(pid, platform);
    signalAnchor = observed === null ? null : { pid, incarnation: observed };
  };

  /** Read the baseline. `null` means this attempt never observed that pid, which is a refusal to signal —
   *  never a conclusion that the process is gone. */
  const signalAnchorFor = (pid: number): ProcessIncarnation | null =>
    signalAnchor?.pid === pid ? signalAnchor.incarnation : null;

  /** Every transition that abandons the current incumbent goes through here, so no piece of attempt
   *  state can be forgotten. Leaving `signalAnchor` behind was possible when the 'gone' branches cleared
   *  their own fields: a later incumbent reusing that pid would inherit a baseline already known to
   *  describe a dead process. */
  const abandonIncumbent = (): void => {
    incumbent = null;
    pendingSignal = null;
    signalAnchor = null;
  };

  const resetForNewIncumbent = (fresh: IncumbentIdentity): void => {
    backendLog.info(`Incumbent discovery changed before signaling; retrying handoff against pid=${fresh.pid}`);
    abandonIncumbent();
  };

  while (true) {
    if (pendingSignal !== null) {
      let activePendingSignal: PendingSignalSettlement = pendingSignal;
      let targetGoneMessage: string | null = null;
      try {
        await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
        const pendingBindResult = await opts.bindAttempt();
        if (pendingBindResult.kind === 'bound') {
          settleBoundSocketAgainstPendingSignal(opts, activePendingSignal, platform);
          return createBoundCoordinator(sawIncumbent, opts);
        }
        opts.signal?.throwIfAborted();
        const graceMs = activePendingSignal.signal === 'SIGTERM' ? SIGTERM_GRACE_MS : SIGKILL_GRACE_MS;
        if (opts.runtime.time.now() - activePendingSignal.acceptedAtMs < graceMs) {
          continue;
        }
        const transition = advanceExpiredPendingSignal(opts, activePendingSignal, signalPolicy, lastHealth, platform);
        if (transition.kind === 'target-gone') {
          targetGoneMessage = transition.message;
        } else {
          activePendingSignal = transition.pending;
          pendingSignal = activePendingSignal;
          backendLog.error(
            `Incumbent remained alive after the kernel accepted SIGTERM and its grace elapsed; kernel accepted SIGKILL for pid=${activePendingSignal.target.pid}`,
          );
        }
      } catch (error: unknown) {
        const abortSignal = opts.signal;
        if (abortSignal?.aborted === true && error === abortSignal.reason) {
          const observation = observePendingSignal(activePendingSignal, opts.runtime.process, platform);
          backendLog.warn(
            `Startup aborted after the kernel accepted ${activePendingSignal.signal} for incumbent pid=${activePendingSignal.target.pid}; observed target status=${observation.kind}`,
          );
          throw error;
        }
        if (error instanceof HandoffEscalationError) {
          throw error;
        }
        refuseAfterPendingSignalFailure(opts, activePendingSignal, platform, error);
      }
      if (targetGoneMessage !== null) {
        backendLog.info(targetGoneMessage);
        abandonIncumbent();
        await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
      }
      continue;
    }

    opts.signal?.throwIfAborted();
    const result = await opts.bindAttempt();
    if (result.kind === 'bound') {
      return createBoundCoordinator(sawIncumbent, opts);
    }
    if (result.kind === 'addressed-incumbent') {
      opts = { ...opts, socketPath: result.socketPath };
    }

    sawIncumbent = true;
    let remaining = deadline - opts.runtime.time.now();
    if (remaining > 0) {
      const shutdownCredentialIdentity = readFreshDiscovery(opts, lastHealth);
      let discoveryMerge = mergeVerifiedDiscovery(incumbent, shutdownCredentialIdentity);
      if (discoveryMerge.kind === 'changed') {
        resetForNewIncumbent(discoveryMerge.fresh);
        await sleepForHandoffPoll(opts, Math.min(SOCKET_BIND_POLL_MS, remaining));
        continue;
      }
      incumbent = discoveryMerge.incumbent;
      if (incumbent !== null) {
        takeSignalAnchor(incumbent.pid);
      }
      const shutdownCredential = shutdownCredentialIdentity?.bootToken;
      const shutdownResult = await requestIncumbentShutdown({
        socketPath: opts.socketPath,
        desired: opts.desired,
        bootToken: shutdownCredential,
        timeoutMs: Math.min(SHUTDOWN_RPC_TIMEOUT_MS, remaining),
        timePort: opts.runtime.time,
      });
      lastHealth = shutdownResult.health ?? lastHealth;
      if (shutdownResult.verifiedIdentity) {
        takeSignalAnchor(shutdownResult.verifiedIdentity.pid);
      }
      if (shutdownResult.verifiedIdentity && incumbent === null) {
        incumbent = shutdownResult.verifiedIdentity;
        const incumbentBundleHash = shutdownResult.health?.bundleHash ?? 'unknown';
        backendLog.info(`Incumbent bundleHash=${incumbentBundleHash} pid=${incumbent.pid}; requested shutdown via IPC`);
      }
      discoveryMerge = mergeVerifiedDiscovery(incumbent, readFreshDiscovery(opts, lastHealth));
      if (discoveryMerge.kind === 'changed') {
        resetForNewIncumbent(discoveryMerge.fresh);
        await sleepForHandoffPoll(opts, Math.min(SOCKET_BIND_POLL_MS, deadline - opts.runtime.time.now()));
        continue;
      }
      incumbent = discoveryMerge.incumbent;
      if (shutdownResult.shutdownUnauthorized) {
        throw new HandoffEscalationError({
          code: 'handoff_shutdown_capability_rejected',
          context: {
            stage: 'shutdown-request',
            pid: incumbent?.pid ?? 'unknown',
          },
        });
      }
      if (!shutdownResult.shutdownAttempted && incumbent !== null && incumbent.bootToken === undefined) {
        throw new HandoffEscalationError({
          code: 'handoff_shutdown_credential_unavailable',
          context: {
            stage: 'shutdown-request',
            pid: incumbent.pid,
          },
        });
      }
    }
    const pollingMerge = mergeVerifiedDiscovery(incumbent, readFreshDiscovery(opts, lastHealth));
    if (pollingMerge.kind === 'changed') {
      resetForNewIncumbent(pollingMerge.fresh);
      await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
      continue;
    }
    incumbent = pollingMerge.incumbent;
    if (incumbent !== null) {
      takeSignalAnchor(incumbent.pid);
    }

    remaining = deadline - opts.runtime.time.now();
    if (remaining <= 0) {
      opts.signal?.throwIfAborted();
      if (incumbent === null) {
        throw new HandoffEscalationError({
          code: 'handoff_socket_holder_unverified',
          context: {
            stage: 'handoff-deadline',
            socketPath: opts.socketPath,
          },
        });
      }
      if (signalPolicy === 'manual') {
        throw new HandoffEscalationError({
          code: 'handoff_manual_policy',
          context: {
            stage: 'before-signal',
            pid: incumbent.pid,
            policy: 'manual',
          },
        });
      }
      incumbent = refreshIncumbentForSignal(opts, incumbent, lastHealth, {
        stage: 'before-signal',
        pid: incumbent.pid,
      });
      const beforeSignal: Extract<HandoffVerificationContext, { stage: 'before-signal' }> = {
        stage: 'before-signal',
        pid: incumbent.pid,
      };
      const anchoredIncarnation = signalAnchorFor(incumbent.pid);
      if (verifySignalTarget(incumbent, anchoredIncarnation, opts.runtime.process, platform, beforeSignal) === 'gone') {
        backendLog.info(`Incumbent pid=${incumbent.pid} exited before SIGTERM; retrying bind`);
        abandonIncumbent();
        await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
        continue;
      }
      assertSignalCapability(incumbent, beforeSignal);
      assertSignalCooldown(opts, incumbent, 'SIGTERM');
      opts.signal?.throwIfAborted();
      const sigtermResult = signalIncumbent(opts, incumbent, 'SIGTERM');
      if (
        settleSignalAttempt(opts, incumbent, anchoredIncarnation, 'SIGTERM', sigtermResult, platform, {
          stage: 'after-rejected-signal',
          pid: incumbent.pid,
          signal: 'SIGTERM',
        }) === 'target-gone'
      ) {
        backendLog.info(`Incumbent pid=${incumbent.pid} was gone after rejected SIGTERM; retrying bind`);
        abandonIncumbent();
        await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
        continue;
      }
      const acceptedAtMs = opts.runtime.time.now();
      recordSignal(opts, incumbent, 'SIGTERM', acceptedAtMs);
      pendingSignal = {
        signal: 'SIGTERM',
        acceptedAtMs,
        target: incumbent,
        anchoredIncarnation,
      };
      backendLog.warn(
        `Incumbent did not exit within ${opts.totalBudgetMs}ms; kernel accepted SIGTERM for pid=${incumbent.pid}`,
      );
      continue;
    }

    await sleepForHandoffPoll(opts, Math.min(SOCKET_BIND_POLL_MS, remaining));
  }
}
