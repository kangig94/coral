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
  probeProcessIncarnation,
  type ProcessIncarnation,
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
type HandoffSignalResult = 'sent' | 'send_failed';
const HANDOFF_SIGNAL_RECORD_VERSION = 1 as const;

export type HandoffSignalRecord = {
  version: typeof HANDOFF_SIGNAL_RECORD_VERSION;
  socketPath: string;
  pid: number;
  incarnation?: ProcessIncarnation;
  instanceId?: string;
  signal: HandoffSignal;
  signaledAtMs: number;
};

export interface HandoffSignalLedger {
  read(): HandoffSignalRecord | null;
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
        return isHandoffSignalRecord(parsed) ? parsed : null;
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

function isHandoffSignalRecord(value: unknown): value is HandoffSignalRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === HANDOFF_SIGNAL_RECORD_VERSION &&
    typeof record.socketPath === 'string' &&
    Number.isInteger(record.pid) &&
    (record.incarnation === undefined || isProcessIncarnation(record.incarnation)) &&
    (record.instanceId === undefined || typeof record.instanceId === 'string') &&
    (record.signal === 'SIGTERM' || record.signal === 'SIGKILL') &&
    Number.isFinite(record.signaledAtMs)
  );
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
    throw new HandoffEscalationError(
      `Manual repair required: refusing to signal pid=${incumbent.pid} because fresh coordinator discovery was unavailable`,
    );
  }
  if (!sameIncumbent(incumbent, fresh)) {
    throw new HandoffEscalationError(
      `Manual repair required: refusing to signal pid=${incumbent.pid} because fresh coordinator discovery changed`,
    );
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
  throw new HandoffEscalationError(
    `Manual repair required: refusing to signal pid=${incumbent.pid} because verified coordinator discovery lacked ${missing.join(', ')}`,
  );
}

function isSameSignalTarget(record: HandoffSignalRecord, socketPath: string, incumbent: IncumbentIdentity): boolean {
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
  throw new HandoffEscalationError(
    `Manual repair required: refusing repeated handoff ${signal} for pid=${incumbent.pid}; last ${last.signal} was ${ageMs}ms ago`,
  );
}

function recordSignal(opts: HandoffOptions, incumbent: IncumbentIdentity, signal: HandoffSignal): void {
  opts.signalLedger?.write({
    version: HANDOFF_SIGNAL_RECORD_VERSION,
    socketPath: opts.socketPath,
    pid: incumbent.pid,
    ...(incumbent.incarnation === undefined ? {} : { incarnation: incumbent.incarnation }),
    ...(incumbent.instanceId === undefined ? {} : { instanceId: incumbent.instanceId }),
    signal,
    signaledAtMs: opts.runtime.time.now(),
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
    signaledAtMs: opts.runtime.time.now(),
    ...(error === undefined ? {} : { error: signalErrorMessage(error) }),
  };
  writeAuditEvent('handoff_signal', payload, signal === 'SIGKILL' || result === 'send_failed' ? 'error' : 'warn');
}

function signalIncumbent(
  opts: HandoffOptions,
  incumbent: IncumbentIdentity,
  signal: HandoffSignal,
): HandoffSignalResult {
  let result: HandoffSignalResult = 'sent';
  let signalError: unknown;
  try {
    opts.runtime.process.kill(incumbent.pid, signal);
  } catch (error: unknown) {
    result = 'send_failed';
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

type SignalVerificationResult = 'matched' | 'gone';

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
 * anchors an unrelated process, which then matches itself forever. A stale `coordinator.json` left by a
 * crashed daemon plus an ordinary pid wrap is all that takes, and the result is SIGKILL delivered to
 * something this coordinator has no relationship with.
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
  process: Pick<Runtime['process'], 'observeLiveness'>,
  platform: NodeJS.Platform,
): SignalVerificationResult {
  const liveIncarnation = probeProcessIncarnation(incumbent.pid, platform);
  if (liveIncarnation === null) {
    // Unreadable is not gone. Only a pid that no longer exists is gone.
    return process.observeLiveness(incumbent.pid) !== 'absent'
      ? refuseSignal(incumbent, 'process incarnation unavailable while pid is alive')
      : 'gone';
  }
  // Checked after "gone", so a dead incumbent is still recognised as dead and escalation simply stops. What
  // this refuses is the live case: a platform whose identity two processes can share cannot say which one
  // this pid is, and signalling on it would be a coin toss with someone else's process.
  if (!incarnationMayAuthorizeSignal(platform)) {
    return refuseSignal(
      incumbent,
      'this platform cannot produce a process identity strong enough to signal on — stop the Coral backend by its service or socket',
    );
  }
  if (incumbent.incarnation === undefined) {
    return refuseSignal(
      incumbent,
      'the incumbent published no incarnation, so this pid cannot be proven to be it — stop the Coral backend by its service or socket, not by this pid',
    );
  }
  if (incumbent.incarnation !== liveIncarnation) {
    return refuseSignal(incumbent, 'this pid is not the process the incumbent published');
  }
  if (anchoredIncarnation === null) {
    return refuseSignal(incumbent, 'no baseline was observed for this pid while it was authenticated');
  }
  return liveIncarnation === anchoredIncarnation
    ? 'matched'
    : refuseSignal(incumbent, 'pid was recycled after this coordinator observed it');
}

function refuseSignal(incumbent: IncumbentIdentity, reason: string): never {
  throw new HandoffEscalationError(`Refusing to signal unverified incumbent pid=${incumbent.pid}: ${reason}`);
}

/**
 * Repeatedly attempt socket bind. On 'incumbent' result, requestIncumbentShutdown() → health +
 * transport.shutdown; if the incumbent outranks this contender (`incumbentOutranksContender`: matching
 * flavor/namespace, same-or-newer product version) and is not draining, throw IncumbentMatchesError
 * (we're redundant) instead of requesting shutdown. This is the only version comparison on the bind path,
 * and it is the same precedence rule the CLI target-routing path uses (`src/coordinator/handoff-routing.ts`) — a
 * contender never evicts a live incumbent for a version difference alone, so two same-version builds with
 * different bundle hashes cannot both conclude the other side should step down.
 */
export async function bindWithHandoff(opts: HandoffOptions): Promise<BoundCoordinator> {
  const deadline = opts.runtime.time.now() + opts.totalBudgetMs;
  const platform = opts.runtime.env.platform() as NodeJS.Platform;
  const signalPolicy = resolveSignalPolicy(opts);
  let sawIncumbent = false;
  let incumbent: IncumbentIdentity | null = null;
  let lastHealth: IncumbentHealth | null = null;
  let sigtermAt: number | null = null;
  let sigkillAt: number | null = null;
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
    const observed = probeProcessIncarnation(pid, platform);
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
    sigtermAt = null;
    sigkillAt = null;
    signalAnchor = null;
  };

  const resetForNewIncumbent = (fresh: IncumbentIdentity): void => {
    backendLog.info(`Incumbent discovery changed before signaling; retrying handoff against pid=${fresh.pid}`);
    abandonIncumbent();
  };

  while (true) {
    opts.signal?.throwIfAborted();
    const result = await opts.bindAttempt();
    opts.signal?.throwIfAborted();
    if (result.kind === 'bound') {
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
        throw new HandoffEscalationError(
          `Manual shutdown required: incumbent pid=${incumbent?.pid ?? 'unknown'} rejected shutdown capability`,
        );
      }
      if (!shutdownResult.shutdownAttempted && incumbent !== null && incumbent.bootToken === undefined) {
        throw new HandoffEscalationError(
          `Manual shutdown required: refusing handoff for pid=${incumbent.pid} because verified shutdown capability was unavailable`,
        );
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
        throw new HandoffEscalationError('Incumbent socket remained bound, but no verified pid was available');
      }
      if (sigtermAt === null) {
        incumbent = refreshIncumbentForSignal(opts, incumbent, lastHealth);
        if (signalPolicy === 'manual') {
          throw new HandoffEscalationError(
            `Manual repair required: refusing handoff signal for pid=${incumbent.pid} because ${HANDOFF_SIGNAL_POLICY_ENV}=manual`,
          );
        }
        if (verifySignalTarget(incumbent, signalAnchorFor(incumbent.pid), opts.runtime.process, platform) === 'gone') {
          backendLog.info(`Incumbent pid=${incumbent.pid} exited before SIGTERM; retrying bind`);
          abandonIncumbent();
          await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
          continue;
        }
        assertSignalCapability(incumbent);
        assertSignalCooldown(opts, incumbent, 'SIGTERM');
        opts.signal?.throwIfAborted();
        const sigtermResult = signalIncumbent(opts, incumbent, 'SIGTERM');
        recordSignal(opts, incumbent, 'SIGTERM');
        sigtermAt = opts.runtime.time.now();
        backendLog.warn(
          `Incumbent did not exit within ${opts.totalBudgetMs}ms; ${
            sigtermResult === 'sent' ? 'sent' : 'attempted'
          } SIGTERM to pid=${incumbent.pid}`,
        );
      } else if (sigkillAt === null && opts.runtime.time.now() - sigtermAt >= SIGTERM_GRACE_MS) {
        if (signalPolicy === 'term-only') {
          throw new HandoffEscalationError(
            `Manual repair required: incumbent pid=${incumbent.pid} remained bound after SIGTERM and ${HANDOFF_SIGNAL_POLICY_ENV}=term-only forbids SIGKILL`,
          );
        }
        incumbent = refreshIncumbentForSignal(opts, incumbent, lastHealth);
        if (verifySignalTarget(incumbent, signalAnchorFor(incumbent.pid), opts.runtime.process, platform) === 'gone') {
          backendLog.info(`Incumbent pid=${incumbent.pid} exited before SIGKILL; retrying bind`);
          abandonIncumbent();
          await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
          continue;
        }
        assertSignalCapability(incumbent);
        opts.signal?.throwIfAborted();
        const sigkillResult = signalIncumbent(opts, incumbent, 'SIGKILL');
        recordSignal(opts, incumbent, 'SIGKILL');
        sigkillAt = opts.runtime.time.now();
        backendLog.error(
          `Incumbent did not exit after SIGTERM grace; ${
            sigkillResult === 'sent' ? 'sent' : 'attempted'
          } SIGKILL to pid=${incumbent.pid}`,
        );
      } else if (sigkillAt !== null && opts.runtime.time.now() - sigkillAt >= SIGKILL_GRACE_MS) {
        throw new HandoffEscalationError(
          `Incumbent socket remained bound after SIGKILL grace for pid=${incumbent.pid}`,
        );
      }
      await sleepForHandoffPoll(opts, SOCKET_BIND_POLL_MS);
      continue;
    }

    await sleepForHandoffPoll(opts, Math.min(SOCKET_BIND_POLL_MS, remaining));
  }
}
