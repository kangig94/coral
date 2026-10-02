import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';

import { readDiscoveryRecordDisposition, removeBackendInfoIfOwner } from '../infra/backend-discovery.js';
import { type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { listLaunchAdmissions } from '../infra/launch-admission-record.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessLiveness } from '../infra/node-process.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { type UpgradeIntent } from '../infra/upgrade-intent.js';
import { createRealRuntime } from '../runtime/real.js';
import { type LaunchProcess, type LaunchReservation } from './state.js';

export function incumbentAt(runDir: string): { pid: number; incarnation: string | null } | null {
  try {
    const value = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as {
      pid?: unknown;
      incarnation?: unknown;
    };
    return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      ? { pid: value.pid, incarnation: typeof value.incarnation === 'string' ? value.incarnation : null }
      : null;
  } catch {
    return null;
  }
}

export function incumbentLiveness(incumbent: { pid: number; incarnation: string | null }): ProcessLiveness {
  if (incumbent.incarnation !== null) {
    const observed = probeProcessIncarnation(incumbent.pid);
    if (observed !== null && observed !== incumbent.incarnation) return 'absent';
  }
  return observeProcessLiveness(incumbent.pid);
}

export function removeExitedChildDiscovery(runDir: string, identity: LaunchProcess): void {
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', { baseDir: dirname(dirname(runDir)) });
  try {
    const discovery = readDiscoveryRecordDisposition(runtime);
    if (
      discovery.kind === 'record' &&
      discovery.record.pid === identity.pid &&
      discovery.record.incarnation === identity.incarnation &&
      discovery.record.instanceId !== undefined
    ) {
      const removal = removeBackendInfoIfOwner(discovery.record.instanceId, runtime);
      if (removal.kind === 'refused') process.stderr.write(`Coordinator discovery cleanup failed: ${removal.code}\n`);
    }
  } catch (error: unknown) {
    process.stderr.write(`Coordinator discovery cleanup failed: ${String(error)}\n`);
  }
}

export function observedLaunchIncumbent(
  runDir: string,
  flavor: StrictBundleManifest['flavor'],
): UpgradeIntent['incumbent'] | null {
  const runtime = createRealRuntime(flavor, { baseDir: dirname(dirname(runDir)) });
  const discovery = readDiscoveryRecordDisposition(runtime);
  if (
    discovery.kind === 'record' &&
    discovery.record.instanceId !== undefined &&
    discovery.record.version !== undefined &&
    discovery.record.incarnation !== undefined &&
    probeProcessIncarnation(discovery.record.pid) === discovery.record.incarnation
  )
    return {
      instanceId: discovery.record.instanceId,
      pid: discovery.record.pid,
      incarnation: discovery.record.incarnation,
      version: discovery.record.version,
      bundleHash: discovery.record.bundleHash,
      flavor,
    };
  const admission = listLaunchAdmissions(runDir)
    .filter((entry): entry is Extract<typeof entry, { kind: 'readable' }> => entry.kind === 'readable')
    .map((entry) => entry.admission)
    .filter((entry) => probeProcessIncarnation(entry.child.pid) === entry.child.incarnation)
    .sort((a, b) => b.admittedAt - a.admittedAt)[0];
  if (admission === undefined) return null;
  if (admission.build.flavor !== flavor) return null;
  return {
    instanceId: `launch:${admission.launchId}`,
    pid: admission.child.pid,
    incarnation: admission.child.incarnation,
    version: admission.build.version,
    bundleHash: admission.build.bundleHash,
    flavor,
  };
}

export function publishedNativeSupervision(runDir: string, slot: LaunchReservation): boolean {
  const child = slot.child;
  if (child === undefined) return false;
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', {
    baseDir: dirname(dirname(runDir)),
  });
  const discovery = readDiscoveryRecordDisposition(runtime);
  return (
    discovery.kind === 'record' &&
    discovery.record.pid === child.pid &&
    discovery.record.incarnation === child.incarnation &&
    discovery.record.supervision?.launchId === slot.id
  );
}

export async function socketClaimedBeforeDiscovery(
  runDir: string,
  flavor: StrictBundleManifest['flavor'],
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPathForRunDir(runDir, flavor, { platform: process.platform }));
    const finish = (claimed: boolean): void => {
      socket.destroy();
      resolve(claimed);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
