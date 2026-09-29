import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readDiscoveryRecordDisposition } from '#src/infra/backend-discovery.js';
import { readBoundedAdjacentManifest, strictBundleManifestSchema } from '#src/infra/bundle-manifest.js';
import { listLaunchAdmissions } from '#src/infra/launch-admission-record.js';
import { readLaunchStatus } from '#src/infra/launch-status.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { readUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { replacementServing } from '#src/coordinator-launch/health.js';
import { recordLegacyUpgradeIntent } from '#src/coordinator-launch/request.js';

type EvidenceSlot = {
  id: string;
  phase: 'admitted' | 'serving' | 'exited';
  child: { pid: number; incarnation: NonNullable<UpgradeIntent['attemptChild']>['incarnation'] };
  parent: { pid: number; incarnation: NonNullable<UpgradeIntent['attemptChild']>['incarnation'] };
  buildSetId: string;
  purpose: 'startup' | 'contender' | 'succession' | 'recovery' | 'legacy-retirement';
  admittedAt: number;
};

function nominatedSupervisor(
  childPid: number,
): { pid: number; incarnation: NonNullable<UpgradeIntent['attemptChild']>['incarnation'] } | null {
  try {
    const table = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    for (const line of table.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      if (match === null || Number(match[2]) !== childPid || !match[3].includes('coral-sentinel.cjs')) continue;
      const pid = Number(match[1]);
      const incarnation = probeProcessIncarnation(pid);
      if (incarnation !== null) return { pid, incarnation };
    }
  } catch {
    /* A missing process table supplies no evidence. */
  }
  return null;
}

/** The process holding the launch lock, read from the kernel's lock table so observation never contends. */
function launchLockHolder(runDir: string): { pid: number; incarnation: ProcessIncarnation } | null {
  let inode: number;
  try {
    inode = statSync(supervisorLockPath(runDir)).ino;
  } catch {
    return null;
  }
  for (const line of readFileSync('/proc/locks', 'utf8').split('\n')) {
    const match = /^\d+:\s+POSIX\s+ADVISORY\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/u.exec(line);
    if (match === null || Number(match[2]) !== inode) continue;
    const pid = Number(match[1]);
    const incarnation = probeProcessIncarnation(pid);
    if (incarnation !== null) return { pid, incarnation };
  }
  return null;
}

/** A read-only test view assembled from the production recovery evidence. */
export class SupervisorEvidence {
  private readonly runDir: string;
  private readonly observed = new Map<string, EvidenceSlot>();
  private readonly healthy = new Set<string>();
  private readonly healthProbes = new Set<string>();
  private firstParentPid: number | null = null;
  private readonly refused = new Map<
    string,
    {
      id: string;
      executable: string;
      buildSetId: string;
      incumbent: UpgradeIntent['incumbent'];
      status: 'unavailable';
      completionReceipt: null;
    }
  >();

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  read() {
    const runtime = createRealRuntime(this.runDir.endsWith('run-dev') ? 'dev' : 'prod', {
      baseDir: dirname(dirname(this.runDir)),
    });
    const discovery = readDiscoveryRecordDisposition(runtime, join(this.runDir, 'coordinator.json'));
    const admitted: EvidenceSlot[] = listLaunchAdmissions(this.runDir).flatMap((entry) =>
      entry.kind === 'readable' &&
      probeProcessIncarnation(entry.admission.child.pid) === entry.admission.child.incarnation
        ? [
            {
              id: entry.admission.launchId,
              phase: 'admitted' as const,
              child: entry.admission.child,
              parent: entry.admission.parent,
              buildSetId: entry.admission.build.buildSetId,
              purpose: entry.admission.purpose,
              admittedAt: entry.admission.admittedAt,
            },
          ]
        : [],
    );
    const discoveredAdmission =
      discovery.kind === 'record' ? admitted.find((entry) => entry.child.pid === discovery.record.pid) : undefined;
    const discoveredIncarnation =
      discovery.kind === 'record'
        ? (discovery.record.incarnation ?? discoveredAdmission?.child.incarnation)
        : undefined;
    const serving: EvidenceSlot | null =
      discovery.kind !== 'record' || discoveredIncarnation === undefined
        ? null
        : discovery.record.supervision !== undefined
          ? {
              id: discovery.record.supervision.launchId,
              phase: this.healthy.has(discovery.record.supervision.launchId) ? 'serving' : 'admitted',
              child: { pid: discovery.record.pid, incarnation: discoveredIncarnation },
              parent: discovery.record.supervision.parent,
              buildSetId: discovery.record.supervision.buildSetId,
              purpose: discovery.record.supervision.purpose,
              admittedAt: discovery.record.supervision.admittedAt,
            }
          : discoveredAdmission?.child.incarnation === discoveredIncarnation
            ? {
                ...discoveredAdmission,
                phase: this.healthy.has(discoveredAdmission.id) ? 'serving' : 'admitted',
              }
            : null;
    if (serving !== null && !this.healthy.has(serving.id) && !this.healthProbes.has(serving.id)) {
      this.healthProbes.add(serving.id);
      void replacementServing(
        this.runDir,
        discovery.kind === 'record' ? discovery.record.flavor : 'prod',
        serving.child.pid,
      )
        .then((healthy) => {
          if (healthy) this.healthy.add(serving.id);
        })
        .finally(() => this.healthProbes.delete(serving.id));
    }
    for (const entry of [...admitted, ...(serving === null ? [] : [serving])]) {
      this.observed.set(entry.id, entry);
      this.firstParentPid ??= entry.parent.pid;
    }
    const children = [...this.observed.values()].map((entry) =>
      probeProcessIncarnation(entry.child.pid) === entry.child.incarnation
        ? entry
        : { ...entry, phase: 'exited' as const },
    );
    const intent = readUpgradeIntent(this.runDir);
    const attemptChild = intent.kind === 'readable' ? intent.intent.attemptChild : null;
    const attempt =
      (attemptChild === null || attemptChild === undefined
        ? null
        : children.find(
            (entry) => entry.child.pid === attemptChild.pid && entry.child.incarnation === attemptChild.incarnation,
          )) ??
      children.find((entry) => entry.purpose === 'succession' || entry.purpose === 'contender') ??
      null;
    const launch =
      children.find((entry) => entry.id !== attempt?.id && entry.phase !== 'exited') ??
      (attempt?.phase === 'exited' ? (children.find((entry) => entry.id !== attempt.id) ?? attempt) : attempt);
    const current = serving ?? admitted.at(-1) ?? launch;
    const nominated = children
      .filter((entry) => entry.phase !== 'exited')
      .map((entry) => ({ entry, process: nominatedSupervisor(entry.child.pid) }))
      .find((candidate) => candidate.process !== null);
    const status = readLaunchStatus(this.runDir);
    const visible = status.kind === 'readable' ? status.status : null;
    const lastBuildSetId =
      intent.kind === 'readable' ? intent.intent.target.build.buildSetId : children.at(-1)?.buildSetId;
    const waitingSupervisor =
      (current === null || current === undefined) && lastBuildSetId !== undefined
        ? launchLockHolder(this.runDir)
        : null;
    return {
      launch,
      attempt: launch === attempt ? null : attempt,
      owner:
        current === null || current === undefined
          ? waitingSupervisor === null || lastBuildSetId === undefined
            ? null
            : {
                process: waitingSupervisor,
                buildSetId: lastBuildSetId,
                mode: 'supervised' as const,
              }
          : nominated !== undefined && nominated.process !== null
            ? { process: nominated.process, buildSetId: nominated.entry.buildSetId, mode: 'recovering' as const }
            : probeProcessIncarnation(current.parent.pid) !== current.parent.incarnation
              ? null
              : {
                  process: current.parent,
                  buildSetId: current.buildSetId,
                  mode:
                    current.parent.pid !== this.firstParentPid && current.id === launch?.id
                      ? 'supervised'
                      : current.parent.pid !== this.firstParentPid
                        ? 'recovering'
                        : 'supervised',
                },
      hold: visible?.hold,
      inheritedHolds: visible?.inheritedHolds ?? [],
      signalHolds: visible?.signalHolds ?? [],
      intent: intent.kind === 'readable' ? intent.intent : null,
      requests: [
        ...this.refused.values(),
        ...(intent.kind !== 'readable'
          ? []
          : [
              {
                id: intent.intent.requestId,
                executable: join(intent.intent.target.pluginRootLabel, 'bridge', 'coral-backend.cjs'),
                buildSetId: intent.intent.target.build.buildSetId,
                incumbent: intent.intent.incumbent,
                status:
                  intent.intent.disposition === 'completed'
                    ? 'completed'
                    : intent.intent.disposition === 'closed'
                      ? 'unavailable'
                      : 'accepted',
                completionReceipt: intent.intent.completionReceipt,
              },
            ]),
      ],
    };
  }

  lockHolder(): { pid: number; incarnation: ProcessIncarnation } | null {
    return launchLockHolder(this.runDir);
  }

  close(): void {}

  async request(
    executable: string,
    buildSetId: string,
    incumbent?: UpgradeIntent['incumbent'],
  ): Promise<{ id: string }> {
    const adjacent = readBoundedAdjacentManifest(dirname(executable));
    const manifest = adjacent.ok ? strictBundleManifestSchema.safeParse(adjacent.value) : null;
    if (manifest === null || !manifest.success || manifest.data.buildSetId !== buildSetId)
      throw new Error('Test request executable has no matching build manifest');
    const discovery = readDiscoveryRecordDisposition(
      createRealRuntime(manifest.data.flavor, {
        baseDir: dirname(dirname(this.runDir)),
      }),
      join(this.runDir, 'coordinator.json'),
    );
    const recorded = discovery.kind === 'record' ? discovery.record : null;
    const starting = this.read().launch;
    let startingManifest: ReturnType<typeof strictBundleManifestSchema.safeParse> | null = null;
    if (starting !== null && starting !== undefined) {
      try {
        const command = execFileSync('ps', ['-o', 'args=', '-p', String(starting.child.pid)], { encoding: 'utf8' });
        const executablePath = /\S*\/bridge\/coral-backend\.cjs/u.exec(command)?.[0];
        if (executablePath !== undefined) {
          const source = readBoundedAdjacentManifest(dirname(executablePath));
          startingManifest = source.ok ? strictBundleManifestSchema.safeParse(source.value) : null;
        }
      } catch {
        /* The starting child may have exited before this observation. */
      }
    }
    const previous =
      incumbent ??
      (recorded !== null && recorded.instanceId !== undefined && recorded.version !== undefined
        ? {
            instanceId: recorded.instanceId,
            pid: recorded.pid,
            incarnation: recorded.incarnation ?? null,
            version: recorded.version,
            bundleHash: recorded.bundleHash,
            flavor: recorded.flavor,
          }
        : starting !== null && starting !== undefined && startingManifest?.success
          ? {
              instanceId: 'startup',
              pid: starting.child.pid,
              incarnation: starting.child.incarnation,
              version: startingManifest.data.version,
              bundleHash: startingManifest.data.bundleHash,
              flavor: startingManifest.data.flavor,
            }
          : {
              instanceId: 'startup',
              pid: process.pid,
              incarnation: 'fixture-absent' as ProcessIncarnation,
              version: '0.0.0',
              bundleHash: 'startup',
              flavor: manifest.data.flavor,
            });
    const id = randomUUID();
    const result = await recordLegacyUpgradeIntent({
      runDir: this.runDir,
      requestId: id,
      incumbent: previous,
      target: { build: manifest.data, pluginRootLabel: dirname(dirname(executable)) },
    });
    if (result.kind === 'refused') {
      this.refused.set(id, {
        id,
        executable,
        buildSetId,
        incumbent: previous,
        status: 'unavailable',
        completionReceipt: null,
      });
      return { id };
    }
    return { id: result.requestId };
  }
}
