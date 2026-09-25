import { randomUUID } from 'node:crypto';

import { compareProductVersions } from '../infra/product-version.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntent } from '../infra/upgrade-intent.js';
import { startUpgradeWaiter } from './index.js';
import type { LegacyUpgradeStart } from '../infra/legacy-upgrade-contract.js';

/** A legacy incumbent cannot record the newer target's intent for itself. */
export async function requestLegacyUpgrade(
  options: Readonly<{
    runDir: string;
    socketPath: string;
    incumbent: UpgradeIntent['incumbent'];
    target: UpgradeIntent['target'];
    startWaiter?: typeof startUpgradeWaiter;
  }>,
): Promise<LegacyUpgradeStart> {
  const startWaiter = options.startWaiter ?? startUpgradeWaiter;
  try {
    if (
      options.target.build.flavor !== options.incumbent.flavor ||
      compareProductVersions(options.target.build.version, options.incumbent.version) <= 0
    )
      return { kind: 'refused', reason: 'target does not strictly outrank the incumbent' };
  } catch {
    return { kind: 'refused', reason: 'build version is invalid' };
  }

  for (let retry = 0; retry < 8; retry++) {
    const observed = readUpgradeIntent(options.runDir);
    if (observed.kind !== 'absent' && observed.kind !== 'readable') {
      return { kind: 'refused', reason: `upgrade intent is ${observed.kind}` };
    }
    const current = observed.kind === 'readable' ? observed.intent : null;
    if (current !== null && current.disposition !== 'closed' && current.disposition !== 'completed') {
      if (
        current.incumbent.instanceId !== options.incumbent.instanceId ||
        current.incumbent.pid !== options.incumbent.pid ||
        current.incumbent.incarnation !== options.incumbent.incarnation
      ) {
        return { kind: 'refused', reason: 'pending intent names another incumbent' };
      }
      let targetOrder: number;
      try {
        targetOrder = compareProductVersions(current.target.build.version, options.target.build.version);
      } catch {
        return { kind: 'refused', reason: 'pending target version is invalid' };
      }
      if (current.target.build.flavor !== options.target.build.flavor) {
        return { kind: 'refused', reason: 'pending target has another build flavor' };
      }
      if (targetOrder >= 0) {
        if (current.retryCondition?.kind !== 'incumbent-retirement') {
          const updated = await compareAndSwapUpgradeIntent(options.runDir, current.revision, {
            ...current,
            retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting for verified natural retirement' },
          });
          if (updated.kind === 'conflict') continue;
          if (updated.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${updated.kind}` };
        }
        const waiter = await startWaiter({
          runDir: options.runDir,
          socketPath: options.socketPath,
          targetRoot: current.target.pluginRootLabel,
        });
        return waiter.kind === 'unavailable'
          ? { kind: 'deferred', requestId: current.requestId, reason: waiter.reason }
          : { kind: 'waiting', requestId: current.requestId, waiter };
      }
    }
    const requestId = randomUUID();
    const written = await compareAndSwapUpgradeIntent(options.runDir, current?.revision ?? null, {
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
    });
    if (written.kind === 'conflict') continue;
    if (written.kind !== 'written') return { kind: 'refused', reason: `upgrade intent is ${written.kind}` };
    const waiter = await startWaiter({
      runDir: options.runDir,
      socketPath: options.socketPath,
      targetRoot: options.target.pluginRootLabel,
    });
    return waiter.kind === 'unavailable'
      ? { kind: 'deferred', requestId, reason: waiter.reason }
      : { kind: 'waiting', requestId, waiter };
  }
  return { kind: 'refused', reason: 'upgrade intent changed concurrently' };
}
