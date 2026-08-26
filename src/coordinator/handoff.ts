// Coordinator-side bind/escalation state machine. Sits above transport's
// `requestIncumbentShutdown`: speaks IPC for graceful handoff, polls
// bindability, and only signals (SIGTERM → SIGKILL) after revalidating the
// incumbent's pid+incarnation against the kernel.
//
// All time/process/env access flows through `runtime` ports per the Single
// Runtime World rule.

import { join } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import {
  incarnationMayAuthorizeSignal,
  isProcessIncarnation,
  type ProcessIncarnation,
  type ProcessLiveness,
} from '../infra/node-process.js';
import { backendLog } from '../infra/backend-log.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { Runtime } from '../runtime/ports.js';
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
const SIGNAL_LEDGER_FILE = 'handoff-signal.json';
export const HANDOFF_SIGNAL_POLICY_ENV = 'CORAL_HANDOFF_SIGNAL_POLICY';

/**
 * Raised when the contender exhausts the bounded escalation window without
 * acquiring the socket — typically because no verified pid was available, or
 * a revalidation step refused to signal an unverified target. Distinguished
 * from `IncumbentMatchesError` (we are redundant) and from per-step IPC
 * errors (transient).
 */
export class HandoffEscalationError extends Error {
  constructor(message: string) {
    super(message);
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

export type HandoffBindResult = { kind: 'bound' } | { kind: 'incumbent'; reason: string };

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

type HandoffRefusalCause =
  | 'fresh-discovery-unavailable'
  | 'fresh-discovery-changed'
  | 'signal-capability-unavailable'
  | 'signal-cooldown-active'
  | 'legacy-signal-attempt-indeterminate'
  | 'shutdown-capability-rejected'
  | 'shutdown-credential-unavailable'
  | 'socket-holder-unverified'
  | 'manual-policy'
  | 'term-only-policy'
  | 'process-identity-unavailable'
  | 'process-liveness-unknown'
  | 'platform-identity-insufficient'
  | 'published-incarnation-missing'
  | 'published-incarnation-mismatch'
  | 'signal-anchor-missing'
  | 'pid-recycled'
  | 'signal-rejected-live'
  | 'accepted-signal-target-alive-after-bind';

type SignalRefusalText = Readonly<{
  description: string;
  successor: string;
}>;

const HANDOFF_REFUSAL_REGISTRY = {
  'fresh-discovery-unavailable': {
    description: 'fresh coordinator discovery was unavailable',
    successor: 'Retry when verified discovery is available',
  },
  'fresh-discovery-changed': {
    description: 'fresh coordinator discovery changed',
    successor: 'Retry handoff against the newly discovered incumbent',
  },
  'signal-capability-unavailable': {
    description: 'verified coordinator discovery lacks required signal-capability fields',
    successor:
      'Repair or replace the coordinator discovery record, or stop the target through its host service, then retry handoff',
  },
  'signal-cooldown-active': {
    description: 'the handoff signal cooldown has not elapsed',
    successor: 'Wait for the cooldown to elapse, then retry handoff',
  },
  'legacy-signal-attempt-indeterminate': {
    description: 'the legacy V1 handoff record proves only that a signal was attempted, not that it was accepted',
    successor: 'Inspect the identified target and wait for the legacy attempt cooldown to elapse, then retry handoff',
  },
  'shutdown-capability-rejected': {
    description: 'the incumbent rejected the shutdown capability',
    successor:
      'Stop the incumbent that owns the coordinator socket through the service or account that owns it, then retry handoff',
  },
  'shutdown-credential-unavailable': {
    description: 'verified coordinator discovery had no boot credential for shutdown',
    successor: 'Stop the identified incumbent through the service or account that owns it, then retry handoff',
  },
  'socket-holder-unverified': {
    description: 'the socket remained bound but no verified holder pid was available',
    successor: 'Inspect and recover the process or stale socket that holds the coordinator socket, then retry handoff',
  },
  'manual-policy': {
    description: `${HANDOFF_SIGNAL_POLICY_ENV}=manual forbids automated handoff signals`,
    successor: `Stop the target through the service or account that owns it, then retry handoff; or deliberately change ${HANDOFF_SIGNAL_POLICY_ENV} and retry`,
  },
  'term-only-policy': {
    description: `${HANDOFF_SIGNAL_POLICY_ENV}=term-only forbids SIGKILL`,
    successor: `Wait for the target's own shutdown to finish or stop it through the service or account that owns it, then retry handoff; or deliberately change ${HANDOFF_SIGNAL_POLICY_ENV} and retry`,
  },
  'process-identity-unavailable': {
    description: 'the process incarnation was unavailable and pid absence was not established',
    successor:
      'Retry when a fresh process-identity observation for this pid succeeds; if it remains unavailable, inspect and stop the target through its host service before retrying handoff',
  },
  'process-liveness-unknown': {
    description: 'the target identity matched but its current liveness could not be observed',
    successor:
      'Retry when a process-liveness observation for this pid succeeds; if it remains unavailable, inspect and stop the target through its host service before retrying handoff',
  },
  'platform-identity-insufficient': {
    description: 'this platform cannot produce a process identity strong enough to authorize a signal',
    successor: 'Stop the Coral backend through its service or socket, not by pid, then retry handoff',
  },
  'published-incarnation-missing': {
    description: 'the incumbent published no incarnation, so this pid cannot be proven to be it',
    successor: 'Stop the Coral backend through its service or socket, not by this pid, then retry handoff',
  },
  'published-incarnation-mismatch': {
    description: 'this pid is not the process the incumbent published',
    successor:
      'Retry handoff against a freshly discovered incumbent; if the mismatch persists, stop the target through its host service before retrying handoff',
  },
  'signal-anchor-missing': {
    description: 'no baseline was observed for this pid while it was authenticated',
    successor:
      'Retry handoff so a new attempt can establish an authenticated baseline; if it cannot, stop the target through its host service before retrying handoff',
  },
  'pid-recycled': {
    description: 'the pid was recycled after this coordinator observed it',
    successor:
      'Retry handoff against the current incumbent; if ownership remains unclear, stop it through its host service before retrying handoff',
  },
  'signal-rejected-live': {
    description:
      'the process port rejected the signal request while the verified target remained alive; this process may lack permission or the target may be outside its signal reach',
    successor: 'Stop the target through the service or account that owns it, then retry handoff',
  },
  'accepted-signal-target-alive-after-bind': {
    description: 'the coordinator socket became bindable before the accepted signal target was observed gone',
    successor:
      'Wait for the identified target to finish shutting down or stop it through the service or account that owns it, then retry startup',
  },
} satisfies Record<HandoffRefusalCause, SignalRefusalText>;

const HANDOFF_SIGNAL_RECORD_VERSION = 2 as const;

export type HandoffSignalRecord = {
  version: typeof HANDOFF_SIGNAL_RECORD_VERSION;
  accepted: true;
  socketPath: string;
  pid: number;
  incarnation?: ProcessIncarnation;
  instanceId?: string;
  signal: HandoffSignal;
  signaledAtMs: number;
};

export type LegacyHandoffSignalAttemptRecord = Omit<HandoffSignalRecord, 'accepted' | 'version'> & {
  version: 1;
};

type HandoffSignalLedgerRecord = HandoffSignalRecord | LegacyHandoffSignalAttemptRecord;

export interface HandoffSignalLedger {
  read(): HandoffSignalLedgerRecord | null;
  write(record: HandoffSignalRecord): void;
}

type HandoffSignalLedgerStorage = Pick<StoragePort, 'mkdirSync' | 'readFileSync' | 'writeAtomicSync'>;

export function createFileHandoffSignalLedger(options: {
  storage: HandoffSignalLedgerStorage;
  runDir: string;
}): HandoffSignalLedger {
  const path = join(options.runDir, SIGNAL_LEDGER_FILE);
  return {
    read: () => {
      try {
        const parsed = JSON.parse(options.storage.readFileSync(path, 'utf-8')) as unknown;
        return decodeHandoffSignalLedgerRecord(parsed);
      } catch {
        return null;
      }
    },
    write: (record) => {
      try {
        options.storage.mkdirSync(options.runDir, { recursive: true });
        options.storage.writeAtomicSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 });
      } catch {
        // Audit/cooldown is best-effort. A write failure must not leave a
        // verified incumbent permanently unreplaceable.
      }
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
    Number.isFinite(record.signaledAtMs);
  if (!commonShapeIsValid) {
    return null;
  }
  if (record.version === 1) {
    return record as LegacyHandoffSignalAttemptRecord;
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
): IncumbentIdentity {
  const fresh = readFreshDiscovery(opts, lastHealth);
  if (fresh === null) {
    return refuseHandoff(`Refusing to signal pid=${incumbent.pid}`, 'fresh-discovery-unavailable');
  }
  if (!sameIncumbent(incumbent, fresh)) {
    return refuseHandoff(`Refusing to signal pid=${incumbent.pid}`, 'fresh-discovery-changed');
  }
  return fresh;
}

function missingSignalCapabilityFields(incumbent: IncumbentIdentity): string[] {
  const missing: string[] = [];
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

function assertSignalCapability(incumbent: IncumbentIdentity): void {
  const missing = missingSignalCapabilityFields(incumbent);
  if (missing.length === 0) {
    return;
  }
  refuseHandoff(
    `Refusing to signal pid=${incumbent.pid}`,
    'signal-capability-unavailable',
    `missing ${missing.join(', ')}`,
  );
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
  const last = ledger.read();
  if (last === null || !isSameSignalTarget(last, opts.socketPath, incumbent)) {
    return;
  }
  const cooldownMs = opts.signalCooldownMs ?? DEFAULT_SIGNAL_COOLDOWN_MS;
  const ageMs = opts.runtime.time.now() - last.signaledAtMs;
  if (ageMs >= cooldownMs) {
    return;
  }
  if (last.version === 1) {
    refuseHandoff(
      `Refusing ${signal} for pid=${incumbent.pid}`,
      'legacy-signal-attempt-indeterminate',
      `legacy ${last.signal} attempt was ${ageMs}ms ago; retry in ${cooldownMs - ageMs}ms`,
    );
  }
  refuseHandoff(
    `Refusing repeated ${signal} for pid=${incumbent.pid}`,
    'signal-cooldown-active',
    `last ${last.signal} was ${ageMs}ms ago; retry in ${cooldownMs - ageMs}ms`,
  );
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

export const SIGNAL_SETTLEMENT_OUTCOME_KINDS = ['gone', 'alive', 'unverifiable'] as const;

type SignalTargetObservation =
  | { kind: 'gone' }
  | { kind: 'alive' }
  | { kind: 'unverifiable'; cause: HandoffRefusalCause };

type SignalAttemptDisposition = 'pending-settlement' | 'settle-rejection';

export function decideSignalAttempt(result: HandoffSignalResult): SignalAttemptDisposition {
  return result === 'accepted' ? 'pending-settlement' : 'settle-rejection';
}

type BindCompletionDisposition = 'complete' | 'continue' | 'settle-pending';

export function decideBindCompletion(
  result: HandoffBindResult,
  hasPendingSignalSettlement: boolean,
): BindCompletionDisposition {
  if (result.kind !== 'bound') {
    return 'continue';
  }
  return hasPendingSignalSettlement ? 'settle-pending' : 'complete';
}

export function classifySignalLiveness(liveness: ProcessLiveness): SignalTargetObservation {
  switch (liveness) {
    case 'absent':
      return { kind: 'gone' };
    case 'alive':
      return { kind: 'alive' };
    case 'unknown':
      return { kind: 'unverifiable', cause: 'process-liveness-unknown' };
  }
}

/**
 * Confirms the pid about to be signalled is still the process this attempt observed, by comparing two
 * probes **this contender made itself**.
 *
 * The self-anchor exists because the old cross-process comparison was unsound: the derived value carried
 * a per-process clock term, so two processes never agreed. The token retired that term — a recorded
 * incarnation and a fresh probe of the same process now produce the same bytes.
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
): SignalVerificationResult {
  const observation = observeSignalTarget(incumbent, anchoredIncarnation, process, platform);
  return observation.kind === 'unverifiable'
    ? refuseHandoff(`Refusing to signal unverified incumbent pid=${incumbent.pid}`, observation.cause)
    : observation.kind;
}

function observeSignalTarget(
  incumbent: IncumbentIdentity,
  anchoredIncarnation: ProcessIncarnation | null,
  process: Pick<Runtime['process'], 'observeLiveness' | 'readProcessIncarnation'>,
  platform: NodeJS.Platform,
): SignalTargetObservation {
  const liveIncarnation = process.readProcessIncarnation(incumbent.pid, platform);
  if (liveIncarnation === null) {
    // Unreadable is not gone. Only a pid that no longer exists is gone.
    return process.observeLiveness(incumbent.pid) === 'absent'
      ? { kind: 'gone' }
      : { kind: 'unverifiable', cause: 'process-identity-unavailable' };
  }
  // An identity that two processes can share cannot authorize a signal or decide which process survived it.
  if (!incarnationMayAuthorizeSignal(platform)) {
    return {
      kind: 'unverifiable',
      cause: 'platform-identity-insufficient',
    };
  }
  if (incumbent.incarnation === undefined) {
    return {
      kind: 'unverifiable',
      cause: 'published-incarnation-missing',
    };
  }
  if (incumbent.incarnation !== liveIncarnation) {
    return { kind: 'unverifiable', cause: 'published-incarnation-mismatch' };
  }
  if (anchoredIncarnation === null) {
    return { kind: 'unverifiable', cause: 'signal-anchor-missing' };
  }
  if (liveIncarnation !== anchoredIncarnation) {
    return { kind: 'unverifiable', cause: 'pid-recycled' };
  }
  return classifySignalLiveness(process.observeLiveness(incumbent.pid));
}

function settleSignalAttempt(
  opts: HandoffOptions,
  incumbent: IncumbentIdentity,
  anchoredIncarnation: ProcessIncarnation | null,
  signal: HandoffSignal,
  result: HandoffSignalResult,
  platform: NodeJS.Platform,
): 'accepted' | 'target-gone' {
  if (decideSignalAttempt(result) === 'pending-settlement') {
    return 'accepted';
  }
  const observation = observeSignalTarget(incumbent, anchoredIncarnation, opts.runtime.process, platform);
  if (observation.kind === 'gone') {
    return 'target-gone';
  }
  if (observation.kind === 'alive') {
    return refuseHandoff(
      `Refusing handoff after ${signal} was rejected for incumbent pid=${incumbent.pid}`,
      'signal-rejected-live',
    );
  }
  return refuseHandoff(
    `Refusing handoff after ${signal} was rejected for incumbent pid=${incumbent.pid} and its current target could not be verified`,
    observation.cause,
  );
}

function refuseHandoff(prefix: string, cause: HandoffRefusalCause, detail?: string): never {
  const refusal = HANDOFF_REFUSAL_REGISTRY[cause];
  const description = detail === undefined ? refusal.description : `${refusal.description}: ${detail}`;
  throw new HandoffEscalationError(`${prefix}: ${description}. ${refusal.successor}`);
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
  | { kind: 'target-unverifiable'; cause: HandoffRefusalCause };

function observePendingSignal(
  pending: PendingSignalSettlement,
  process: Pick<Runtime['process'], 'observeLiveness' | 'readProcessIncarnation'>,
  platform: NodeJS.Platform,
): SignalTargetObservation {
  return observeSignalTarget(pending.target, pending.anchoredIncarnation, process, platform);
}

function throwAfterPendingSignalSettlement(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  platform: NodeJS.Platform,
  error: unknown,
): never {
  const observation = observePendingSignal(pending, opts.runtime.process, platform);
  if (observation.kind === 'unverifiable') {
    refuseHandoff(
      `Handoff failed after the kernel accepted ${pending.signal} for incumbent pid=${pending.target.pid}, but the target could not be verified`,
      observation.cause,
    );
  }
  throw error;
}

async function sleepForPendingSignalPoll(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await opts.runtime.time.sleep(SOCKET_BIND_POLL_MS);
  } catch (error: unknown) {
    throwAfterPendingSignalSettlement(opts, pending, platform, error);
  }
}

type SigtermGraceTransitionOutcome =
  | { kind: 'target-gone'; stage: 'after-sigterm' | 'before-sigkill' | 'after-rejected-sigkill'; pid: number }
  | { kind: 'target-unverifiable'; cause: HandoffRefusalCause; pid: number }
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
    return { kind: 'target-unverifiable', cause: observation.cause, pid: pending.target.pid };
  }
  if (observation.kind === 'gone') {
    return { kind: 'target-gone', stage: 'after-sigterm', pid: pending.target.pid };
  }
  if (policy === 'term-only') {
    return { kind: 'sigkill-forbidden', pid: pending.target.pid };
  }

  const incumbent = refreshIncumbentForSignal(opts, pending.target, lastHealth);
  if (verifySignalTarget(incumbent, pending.anchoredIncarnation, opts.runtime.process, platform) === 'gone') {
    return { kind: 'target-gone', stage: 'before-sigkill', pid: incumbent.pid };
  }
  assertSignalCapability(incumbent);
  opts.signal?.throwIfAborted();
  const result = signalIncumbent(opts, incumbent, 'SIGKILL');
  if (
    settleSignalAttempt(opts, incumbent, pending.anchoredIncarnation, 'SIGKILL', result, platform) === 'target-gone'
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
      return { kind: 'target-unverifiable', cause: observation.cause };
  }
}

type PendingSignalTransitionOutcome =
  | { kind: 'bound-complete' }
  | { kind: 'wait' }
  | { kind: 'target-gone'; message: string }
  | { kind: 'sigkill-accepted'; pending: PendingSignalSettlement };

function transitionPendingSignalSettlement(
  opts: HandoffOptions,
  pending: PendingSignalSettlement,
  bindDisposition: BindCompletionDisposition,
  policy: HandoffSignalPolicy,
  lastHealth: IncumbentHealth | null,
  platform: NodeJS.Platform,
): PendingSignalTransitionOutcome {
  if (bindDisposition === 'settle-pending') {
    const observation = observePendingSignal(pending, opts.runtime.process, platform);
    if (observation.kind === 'unverifiable') {
      refuseHandoff(
        `The socket bound after the kernel accepted ${pending.signal} for incumbent pid=${pending.target.pid}, but the target could not be verified`,
        observation.cause,
      );
    }
    if (observation.kind === 'alive') {
      refuseHandoff(
        `The socket bound after the kernel accepted ${pending.signal} for incumbent pid=${pending.target.pid}`,
        'accepted-signal-target-alive-after-bind',
      );
    }
    return { kind: 'bound-complete' };
  }
  if (opts.signal?.aborted === true) {
    const observation = observePendingSignal(pending, opts.runtime.process, platform);
    if (observation.kind === 'unverifiable') {
      refuseHandoff(
        `Startup was aborted after the kernel accepted ${pending.signal} for incumbent pid=${pending.target.pid}, but the target could not be verified`,
        observation.cause,
      );
    }
    opts.signal.throwIfAborted();
  }
  const graceMs = pending.signal === 'SIGTERM' ? SIGTERM_GRACE_MS : SIGKILL_GRACE_MS;
  if (opts.runtime.time.now() - pending.acceptedAtMs < graceMs) {
    return { kind: 'wait' };
  }
  if (pending.signal === 'SIGKILL') {
    const disposition = transitionAfterSigkillGrace(opts, pending, platform);
    if (disposition.kind === 'target-unverifiable') {
      refuseHandoff(
        `Kernel accepted SIGKILL for incumbent pid=${pending.target.pid} and its grace elapsed, but the current target could not be verified`,
        disposition.cause,
      );
    }
    if (disposition.kind === 'target-gone') {
      throw new HandoffEscalationError(
        `Kernel accepted SIGKILL for incumbent pid=${pending.target.pid}, its grace elapsed, and the target is gone, but its socket remained bound. Retry the original coral-cli mutating command; its bind path clears a stale socket before relaunching`,
      );
    }
    throw new HandoffEscalationError(
      `Kernel accepted SIGKILL for incumbent pid=${pending.target.pid}, its grace elapsed, and the verified target remained alive; under heavy fsync load it may be blocked in uninterruptible I/O, so wait for that I/O to complete and the process to exit before retrying`,
    );
  }

  const transition = transitionAfterSigtermGrace(opts, pending, policy, lastHealth, platform);
  if (transition.kind === 'target-unverifiable') {
    refuseHandoff(
      `Kernel accepted SIGTERM for incumbent pid=${transition.pid} and its grace elapsed, but the current target could not be verified`,
      transition.cause,
    );
  }
  if (transition.kind === 'sigkill-forbidden') {
    refuseHandoff(`Refusing SIGKILL for incumbent pid=${transition.pid} after SIGTERM grace`, 'term-only-policy');
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
export async function bindWithHandoff(opts: HandoffOptions): Promise<BoundCoordinator> {
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
    if (pendingSignal === null) {
      opts.signal?.throwIfAborted();
    }
    let result: HandoffBindResult;
    try {
      result = await opts.bindAttempt();
    } catch (error: unknown) {
      if (pendingSignal !== null) {
        throwAfterPendingSignalSettlement(opts, pendingSignal, platform, error);
      }
      throw error;
    }
    const bindDisposition = decideBindCompletion(result, pendingSignal !== null);
    if (pendingSignal !== null) {
      const transition = transitionPendingSignalSettlement(
        opts,
        pendingSignal,
        bindDisposition,
        signalPolicy,
        lastHealth,
        platform,
      );
      if (transition.kind === 'bound-complete') {
        return createBoundCoordinator(sawIncumbent, opts);
      }
      if (transition.kind === 'target-gone') {
        backendLog.info(transition.message);
        abandonIncumbent();
        await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
        continue;
      }
      if (transition.kind === 'wait') {
        await sleepForPendingSignalPoll(opts, pendingSignal, platform);
        continue;
      }
      pendingSignal = transition.pending;
      backendLog.error(
        `Incumbent remained alive after the kernel accepted SIGTERM and its grace elapsed; kernel accepted SIGKILL for pid=${pendingSignal.target.pid}`,
      );
      await sleepForPendingSignalPoll(opts, pendingSignal, platform);
      continue;
    }

    opts.signal?.throwIfAborted();
    if (bindDisposition === 'complete') {
      return createBoundCoordinator(sawIncumbent, opts);
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
        refuseHandoff(
          `Refusing handoff for incumbent pid=${incumbent?.pid ?? 'unknown'}`,
          'shutdown-capability-rejected',
        );
      }
      if (!shutdownResult.shutdownAttempted && incumbent !== null && incumbent.bootToken === undefined) {
        refuseHandoff(`Refusing handoff for incumbent pid=${incumbent.pid}`, 'shutdown-credential-unavailable');
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
        refuseHandoff(`Refusing handoff for socket ${opts.socketPath}`, 'socket-holder-unverified');
      }
      incumbent = refreshIncumbentForSignal(opts, incumbent, lastHealth);
      if (signalPolicy === 'manual') {
        refuseHandoff(`Refusing handoff signal for pid=${incumbent.pid}`, 'manual-policy');
      }
      const anchoredIncarnation = signalAnchorFor(incumbent.pid);
      if (verifySignalTarget(incumbent, anchoredIncarnation, opts.runtime.process, platform) === 'gone') {
        backendLog.info(`Incumbent pid=${incumbent.pid} exited before SIGTERM; retrying bind`);
        abandonIncumbent();
        await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
        continue;
      }
      assertSignalCapability(incumbent);
      assertSignalCooldown(opts, incumbent, 'SIGTERM');
      opts.signal?.throwIfAborted();
      const sigtermResult = signalIncumbent(opts, incumbent, 'SIGTERM');
      if (
        settleSignalAttempt(opts, incumbent, anchoredIncarnation, 'SIGTERM', sigtermResult, platform) === 'target-gone'
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
      await sleepForPendingSignalPoll(opts, pendingSignal, platform);
      continue;
    }

    await sleepForHandoffPoll(opts, Math.min(SOCKET_BIND_POLL_MS, remaining));
  }
}
