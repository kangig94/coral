import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CoordinatorLaunchRecord, readCoordinatorLaunchDisposition } from '../infra/coordinator-launch.js';
import { observeProcessLiveness, probeProcessIncarnation } from '../infra/node-process.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import { createForeignTargetValidator } from '../infra/handoff-target.js';
import type { LegacyUpgradeStart } from '../infra/legacy-upgrade-contract.js';
import { compareProductVersions } from '../infra/product-version.js';
import type { UpgradeIntent } from '../infra/upgrade-intent.js';

const ACCEPT_TIMEOUT_MS = 5_000;

export async function requestLegacyUpgrade(
  options: Readonly<{
    runDir: string;
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

  if (readCoordinatorLaunchDisposition(options.runDir).kind === 'unreadable')
    return {
      kind: 'refused',
      reason: 'coordinator launch record is unreadable; supervisor recovery is pending',
      disposition: 'deferred',
    };

  let record: CoordinatorLaunchRecord;
  try {
    record = new CoordinatorLaunchRecord(options.runDir);
  } catch {
    return {
      kind: 'refused',
      reason: 'coordinator launch record is unreadable; supervisor recovery is pending',
      disposition: 'deferred',
    };
  }
  try {
    const request = record.request(executable, options.target.build.buildSetId, options.incumbent);
    const state = record.read();
    const ownerIncarnation = state.owner === null ? null : probeProcessIncarnation(state.owner.process.pid);
    if (
      state.owner === null ||
      state.owner.leaseUntil <= Date.now() ||
      (ownerIncarnation !== null && ownerIncarnation !== state.owner.process.incarnation) ||
      (ownerIncarnation === null && observeProcessLiveness(state.owner.process.pid) === 'absent')
    ) {
      const child = spawn(process.execPath, [supervisor, executable], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CORAL_SENTINEL_RUN_DIR: options.runDir },
      });
      child.once('error', () => undefined);
      child.unref();
    }
    const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = record.read();
      const accepted = current.requests.find((entry) => entry.id === request.id);
      if (accepted?.status === 'accepted' || accepted?.status === 'completed')
        return { kind: 'waiting', requestId: request.id, supervisorPid: current.owner?.process.pid ?? null };
      if (
        accepted?.status === 'recorded' &&
        current.owner?.leaseUntil !== undefined &&
        current.owner.leaseUntil > Date.now()
      ) {
        const incarnation = probeProcessIncarnation(current.owner.process.pid);
        if (
          incarnation === current.owner.process.incarnation ||
          (incarnation === null && observeProcessLiveness(current.owner.process.pid) !== 'absent')
        )
          return { kind: 'waiting', requestId: request.id, supervisorPid: current.owner.process.pid };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { kind: 'refused', reason: 'supervisor did not accept the upgrade request', disposition: 'deferred' };
  } catch {
    return {
      kind: 'refused',
      reason: 'coordinator launch record became unreadable; supervisor recovery is pending',
      disposition: 'deferred',
    };
  } finally {
    record.close();
  }
}

export async function recordContenderDeferral(_runDir: string, reason: string): Promise<void> {
  writeAuditEvent('upgrade_contender_deferred', { reason }, 'warn');
}
