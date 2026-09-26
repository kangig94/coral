import { join } from 'node:path';

import { UPGRADE_WAITER_BUNDLE_FILE } from '../infra/bundle-manifest-address.js';
import type { LegacyUpgradeRefusal, LegacyUpgradeStart } from '../infra/legacy-upgrade-contract.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import { compareProductVersions } from '../infra/product-version.js';
import {
  readUpgradeIntent,
  retryUpgradeIntentCas,
  type UpgradeIntent,
  type UpgradeIntentProblem,
} from '../infra/upgrade-intent.js';
import { createRealUpgradeWaiterPorts, type UpgradeWaiterPorts } from '../runtime/upgrade-waiter.js';
import { CONTENDER_DEFERRAL_OWNER, observeRecordedIncumbent } from './index.js';

const WAITER_CLAIM_TIMEOUT_MS = 5_000;
const WAITER_CLAIM_POLL_MS = 50;

export type UpgradeWaiterStart =
  | Readonly<{ kind: 'started' | 'existing'; pid: number }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

function waiterAlive(ports: UpgradeWaiterPorts, owner: NonNullable<UpgradeIntent['attemptOwner']>): boolean {
  if (owner.incarnation === null) return false;
  try {
    return ports.processIncarnation(owner.pid) === owner.incarnation;
  } catch {
    return false;
  }
}

/** The contender must observe a durable waiter owner before it exits. */
export async function startUpgradeWaiter(
  options: Readonly<{
    runDir: string;
    socketPath: string;
    targetRoot: string;
    ports: UpgradeWaiterPorts;
    timeoutMs?: number;
  }>,
): Promise<UpgradeWaiterStart> {
  const { ports } = options;
  const observed = readUpgradeIntent(options.runDir);
  if (observed.kind !== 'readable') return { kind: 'unavailable', reason: `intent is ${observed.kind}` };
  if (observed.intent.target.pluginRootLabel !== options.targetRoot) {
    return { kind: 'unavailable', reason: 'intent target changed' };
  }
  if (observed.intent.disposition === 'completed' || observed.intent.disposition === 'closed') {
    return { kind: 'unavailable', reason: 'intent has ended' };
  }
  const owner = observed.intent.attemptOwner;
  if (
    owner?.kind === 'waiter' &&
    observed.intent.attemptDeadline !== null &&
    Date.parse(observed.intent.attemptDeadline) > ports.time.now()
  ) {
    return waiterAlive(ports, owner)
      ? { kind: 'existing', pid: owner.pid }
      : { kind: 'unavailable', reason: 'recorded waiter died before its lease expired' };
  }
  const pid = await ports.launchDetached(join(options.targetRoot, 'bridge', UPGRADE_WAITER_BUNDLE_FILE), [
    options.runDir,
    options.socketPath,
    options.targetRoot,
  ]);
  if (pid === null) return { kind: 'unavailable', reason: 'waiter process could not start' };
  const deadline = ports.time.now() + (options.timeoutMs ?? WAITER_CLAIM_TIMEOUT_MS);
  while (ports.time.now() < deadline) {
    const current = readUpgradeIntent(options.runDir);
    if (current.kind !== 'readable') return { kind: 'unavailable', reason: `intent is ${current.kind}` };
    if (current.intent.requestId !== observed.intent.requestId) {
      return { kind: 'unavailable', reason: 'intent was superseded' };
    }
    const claimant = current.intent.attemptOwner;
    if (claimant?.kind === 'waiter' && claimant.pid === pid) return { kind: 'started', pid };
    if (
      claimant?.kind === 'waiter' &&
      current.intent.attemptDeadline !== null &&
      Date.parse(current.intent.attemptDeadline) > ports.time.now() &&
      waiterAlive(ports, claimant)
    ) {
      return { kind: 'existing', pid: claimant.pid };
    }
    await ports.time.sleep(WAITER_CLAIM_POLL_MS);
  }
  return { kind: 'unavailable', reason: 'waiter did not claim the intent before the startup deadline' };
}

/**
 * An intent recorded against an incumbent that is proven gone can never be released by that incumbent, so the one
 * now serving may replace it — unless an attempt may still act on it: an incumbent-owned attempt belongs to startup
 * recovery, and a waiter's attempt ends only with its lease.
 */
function retiredIncumbentSupersession(
  ports: UpgradeWaiterPorts,
  intent: UpgradeIntent,
): 'replaceable' | 'attempt-held' | 'incumbent-not-proven-gone' {
  const owner = intent.attemptOwner;
  if (
    owner?.kind === 'incumbent' ||
    (owner?.kind === 'waiter' &&
      intent.attemptDeadline !== null &&
      Date.parse(intent.attemptDeadline) > ports.time.now())
  ) {
    return 'attempt-held';
  }
  return observeRecordedIncumbent(ports, intent.incumbent) === 'absent' ? 'replaceable' : 'incumbent-not-proven-gone';
}

/** A newer generation's intent belongs to the build that wrote it; one this build cannot read at all is an error. */
function intentProblemDisposition(problem: UpgradeIntentProblem): LegacyUpgradeRefusal {
  return problem === 'unsupported' ? 'deferred' : 'error';
}

/** A legacy incumbent cannot record the newer target's intent for itself. */
export async function requestLegacyUpgrade(
  options: Readonly<{
    runDir: string;
    socketPath: string;
    incumbent: UpgradeIntent['incumbent'];
    target: UpgradeIntent['target'];
    ports?: UpgradeWaiterPorts;
    startWaiter?: typeof startUpgradeWaiter;
  }>,
): Promise<LegacyUpgradeStart> {
  const ports = options.ports ?? createRealUpgradeWaiterPorts();
  const startWaiter = options.startWaiter ?? startUpgradeWaiter;
  try {
    if (
      options.target.build.flavor !== options.incumbent.flavor ||
      compareProductVersions(options.target.build.version, options.incumbent.version) <= 0
    )
      return { kind: 'refused', reason: 'target does not strictly outrank the incumbent', disposition: 'redundant' };
  } catch {
    return { kind: 'refused', reason: 'build version is invalid', disposition: 'error' };
  }

  type Registration =
    | Extract<LegacyUpgradeStart, { kind: 'refused' }>
    | Readonly<{ kind: 'registered'; requestId: string; targetRoot: string }>;
  const refuse = (reason: string, disposition: LegacyUpgradeRefusal) =>
    ({ kind: 'settle', value: { kind: 'refused', reason, disposition } }) as const;
  const outcome = await retryUpgradeIntentCas<Registration>(options.runDir, (observed) => {
    if (observed.kind !== 'absent' && observed.kind !== 'readable') {
      return refuse(`upgrade intent is ${observed.kind}`, intentProblemDisposition(observed.kind));
    }
    const current = observed.kind === 'readable' ? observed.intent : null;
    const open = current !== null && current.disposition !== 'closed' && current.disposition !== 'completed';
    const namesIncumbent =
      current?.incumbent.instanceId === options.incumbent.instanceId &&
      current.incumbent.pid === options.incumbent.pid &&
      current.incumbent.incarnation === options.incumbent.incarnation;
    if (open && !namesIncumbent && retiredIncumbentSupersession(ports, current) !== 'replaceable') {
      return refuse('pending intent names another incumbent', 'deferred');
    }
    if (open && namesIncumbent) {
      let targetOrder: number;
      try {
        targetOrder = compareProductVersions(current.target.build.version, options.target.build.version);
      } catch {
        return refuse('pending target version is invalid', 'error');
      }
      if (current.target.build.flavor !== options.target.build.flavor) {
        return refuse('pending target has another build flavor', 'deferred');
      }
      if (targetOrder >= 0) {
        const registered = {
          kind: 'registered',
          requestId: current.requestId,
          targetRoot: current.target.pluginRootLabel,
        } as const;
        if (current.retryCondition?.kind === 'incumbent-retirement') return { kind: 'settle', value: registered };
        return {
          kind: 'write',
          expectedRevision: current.revision,
          change: {
            ...current,
            retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting for verified natural retirement' },
          },
          settle: () => registered,
        };
      }
    }
    const requestId = ports.uuid();
    return {
      kind: 'write',
      expectedRevision: current?.revision ?? null,
      change: {
        requestId,
        incumbent: options.incumbent,
        target: options.target,
        attemptId: null,
        attemptOwner: null,
        disposition: 'pending',
        blockers: [],
        retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting for verified natural retirement' },
        attemptDeadline: null,
        completionReceipt: null,
      },
      settle: () => ({ kind: 'registered', requestId, targetRoot: options.target.pluginRootLabel }),
    };
  });
  if (outcome.kind === 'refused') {
    return {
      kind: 'refused',
      reason: `upgrade intent is ${outcome.problem}`,
      disposition: intentProblemDisposition(outcome.problem),
    };
  }
  if (outcome.kind === 'exhausted') {
    return { kind: 'refused', reason: 'upgrade intent changed concurrently', disposition: 'deferred' };
  }
  const registration = outcome.value;
  if (registration.kind === 'refused') return registration;
  const waiter = await startWaiter({
    runDir: options.runDir,
    socketPath: options.socketPath,
    targetRoot: registration.targetRoot,
    ports,
  });
  return waiter.kind === 'unavailable'
    ? { kind: 'deferred', requestId: registration.requestId, reason: waiter.reason }
    : { kind: 'waiting', requestId: registration.requestId, waiter };
}

/**
 * A contender that defers exits as a redundant contender does, so what it deferred for is left where status reads
 * it: on the open intent when there is one, and in the audit log always.
 */
export async function recordContenderDeferral(runDir: string, reason: string): Promise<void> {
  writeAuditEvent('upgrade_contender_deferred', { reason }, 'warn');
  const blocker = { owner: CONTENDER_DEFERRAL_OWNER, reason };
  void (await retryUpgradeIntentCas<void>(runDir, (observed) => {
    if (
      observed.kind !== 'readable' ||
      observed.intent.disposition === 'closed' ||
      observed.intent.disposition === 'completed' ||
      observed.intent.blockers.some((entry) => entry.owner === blocker.owner && entry.reason === blocker.reason)
    ) {
      return { kind: 'settle', value: undefined };
    }
    return {
      kind: 'write',
      expectedRevision: observed.intent.revision,
      change: {
        ...observed.intent,
        blockers: [...observed.intent.blockers.filter((entry) => entry.owner !== blocker.owner), blocker],
      },
      settle: () => undefined,
    };
  }));
}
