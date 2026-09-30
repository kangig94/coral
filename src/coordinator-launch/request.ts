import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { writeAuditEvent } from '../infra/audit-log.js';
import { createForeignTargetValidator } from '../infra/handoff-target.js';
import type { LegacyUpgradeStart } from '../infra/legacy-upgrade-contract.js';
import { compareProductVersions } from '../infra/product-version.js';
import { readUpgradeIntent, retryUpgradeIntentCas, type UpgradeIntent } from '../infra/upgrade-intent.js';
import { attemptExclusiveFileLockSync } from '../infra/fs-lock.js';
import { supervisorLockPath } from '../infra/path/coordinator.js';

/** A reused shipped incumbent still needs its outstanding upgrade observed under the namespace lock. */
export async function resumeLegacyUpgradeObservation(runDir: string): Promise<void> {
  const observed = readUpgradeIntent(runDir);
  if (
    observed.kind !== 'readable' ||
    observed.intent.legacyRetirement !== true ||
    observed.intent.disposition === 'closed' ||
    observed.intent.disposition === 'completed'
  )
    return;
  const path = supervisorLockPath(runDir);
  if (existsSync(path)) {
    const lock = attemptExclusiveFileLockSync(path);
    if (lock.kind === 'contended') return;
    if (lock.kind === 'acquired') lock.lease();
  }
  const bundleDir = join(observed.intent.target.pluginRootLabel, 'bridge');
  if (createForeignTargetValidator()(bundleDir, observed.intent.target.build).kind !== 'validated')
    throw new Error('Outstanding legacy upgrade target is unavailable');
  const challenge = randomUUID();
  const child = spawn(process.execPath, [join(bundleDir, 'coral-sentinel.cjs'), join(bundleDir, 'coral-backend.cjs')], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, CORAL_SENTINEL_RUN_DIR: runDir, CORAL_OBSERVATION_CHALLENGE: challenge },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Legacy upgrade observer exited before restoring observation')));
      child.on('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'coral-observation-owned' &&
          'challenge' in message &&
          message.challenge === challenge
        )
          resolve();
      });
    });
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

export async function recordLegacyUpgradeIntent(
  options: Readonly<{
    runDir: string;
    requestId: string;
    incumbent: UpgradeIntent['incumbent'];
    target: UpgradeIntent['target'];
  }>,
): Promise<LegacyUpgradeStart> {
  try {
    if (
      options.target.build.flavor !== options.incumbent.flavor ||
      compareProductVersions(options.target.build.version, options.incumbent.version) <= 0
    )
      return { kind: 'refused', reason: 'target does not strictly outrank the incumbent', disposition: 'redundant' };
  } catch {
    return { kind: 'refused', reason: 'build version is invalid', disposition: 'error' };
  }

  const bundleDir = join(options.target.pluginRootLabel, 'bridge');
  const executable = join(bundleDir, 'coral-backend.cjs');
  const supervisor = join(bundleDir, 'coral-sentinel.cjs');
  if (
    createForeignTargetValidator()(bundleDir, options.target.build).kind !== 'validated' ||
    !existsSync(executable) ||
    !existsSync(supervisor)
  )
    return { kind: 'refused', reason: 'target bundle is unavailable', disposition: 'error' };

  const accepted = await retryUpgradeIntentCas<LegacyUpgradeStart>(options.runDir, (observed) => {
    if (observed.kind !== 'absent' && observed.kind !== 'readable')
      return {
        kind: 'settle',
        value: {
          kind: 'refused' as const,
          reason: `upgrade intent is ${observed.kind}`,
          disposition: 'deferred' as const,
        },
      };
    const current = observed.kind === 'readable' ? observed.intent : null;
    if (current !== null && current.disposition !== 'closed' && current.disposition !== 'completed') {
      if (current.attemptId !== null || current.reason === 'supervision-repair') {
        const queued = current.nextTarget ?? null;
        const targetIsNewer =
          current.target.build.flavor === options.target.build.flavor &&
          compareProductVersions(options.target.build.version, current.target.build.version) > 0;
        const queueIsNewer =
          queued !== null && compareProductVersions(queued.target.build.version, options.target.build.version) >= 0;
        if (!targetIsNewer || queueIsNewer)
          return {
            kind: 'settle',
            value: { kind: 'waiting' as const, requestId: queued?.requestId ?? current.requestId, supervisorPid: null },
          };
        return {
          kind: 'write',
          expectedRevision: current.revision,
          change: { ...current, nextTarget: { requestId: options.requestId, target: options.target } },
          settle: () => ({ kind: 'waiting' as const, requestId: options.requestId, supervisorPid: null }),
        };
      }
      if (
        current.incumbent.instanceId === options.incumbent.instanceId &&
        current.target.build.flavor === options.target.build.flavor &&
        compareProductVersions(current.target.build.version, options.target.build.version) >= 0
      )
        return {
          kind: 'settle',
          value: { kind: 'waiting' as const, requestId: current.requestId, supervisorPid: null },
        };
    }
    return {
      kind: 'write',
      expectedRevision: current?.revision ?? null,
      change: {
        requestId: options.requestId,
        incumbent: options.incumbent,
        target: options.target,
        legacyRetirement: true,
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        disposition: 'pending' as const,
        blockers: [],
        retryCondition: null,
        attemptDeadline: null,
        completionReceipt: null,
      },
      settle: (intent: UpgradeIntent) => ({
        kind: 'waiting' as const,
        requestId: intent.requestId,
        supervisorPid: null,
      }),
    };
  });
  if (accepted.kind !== 'settled')
    return { kind: 'refused', reason: 'upgrade intent changed concurrently', disposition: 'deferred' };
  return accepted.value;
}

export async function requestLegacyUpgrade(
  options: Parameters<typeof recordLegacyUpgradeIntent>[0],
): Promise<LegacyUpgradeStart> {
  const accepted = await recordLegacyUpgradeIntent(options);
  if (accepted.kind !== 'waiting') return accepted;
  const bundleDir = join(options.target.pluginRootLabel, 'bridge');
  const executable = join(bundleDir, 'coral-backend.cjs');
  const supervisor = join(bundleDir, 'coral-sentinel.cjs');
  const child = spawn(process.execPath, [supervisor, executable], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CORAL_SENTINEL_RUN_DIR: options.runDir },
  });
  child.once('error', () => undefined);
  child.unref();
  return { ...accepted, supervisorPid: child.pid ?? null };
}

export async function recordContenderDeferral(_runDir: string, reason: string): Promise<void> {
  writeAuditEvent('upgrade_contender_deferred', { reason }, 'warn');
}
