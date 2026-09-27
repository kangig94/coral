import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UpgradeIntent } from '../infra/upgrade-intent.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { UpgradeWaiterPorts } from '../runtime/upgrade-waiter.js';

type SpawnObservation =
  | 'absent'
  | 'alive'
  | 'unknown'
  | 'missing'
  | 'prepared-dead'
  | Readonly<{ kind: 'child'; pid: number; incarnation: ProcessIncarnation }>;

const MISSING_SPAWN_SETTLE_MS = 30_000;

/** A missing record remains unknown until the deadline plus 30 seconds; the sentinel's pre-spawn CAS fences a concurrent release. */
export function pendingSpawnMayBeReleased(spawn: SpawnObservation, deadline: number, now: number): boolean {
  return (
    spawn === 'absent' ||
    ((spawn === 'missing' || spawn === 'prepared-dead') && now >= deadline + MISSING_SPAWN_SETTLE_MS)
  );
}

/** Sentinel records identify a launched target even if its waiter died before recording the child in the intent. */
export function observePendingSpawn(
  runDir: string,
  intent: Pick<UpgradeIntent, 'attemptId' | 'attemptSpawnNonce'>,
  ports: Pick<UpgradeWaiterPorts, 'processIncarnation' | 'processLiveness'>,
): SpawnObservation {
  const directory = join(runDir, 'coordinator-sentinel.v1');
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
  }
  let matched = false;
  let unknown = false;
  let preparedDead = false;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(join(directory, entry), 'utf8')) as Record<string, unknown>;
    } catch {
      return 'unknown';
    }
    if (
      record.attemptId !== intent.attemptId ||
      (intent.attemptSpawnNonce !== undefined &&
        intent.attemptSpawnNonce !== null &&
        record.spawnNonce !== intent.attemptSpawnNonce)
    )
      continue;
    matched = true;
    let childAbsent = false;
    if (typeof record.coordinatorPid === 'number' && record.coordinatorPid > 0) {
      const currentIncarnation = ports.processIncarnation(record.coordinatorPid);
      const childLiveness = ports.processLiveness(record.coordinatorPid);
      if (childLiveness === 'unknown' || (childLiveness === 'alive' && currentIncarnation === null)) {
        unknown = true;
        continue;
      }
      if (
        childLiveness === 'alive' &&
        currentIncarnation !== null &&
        currentIncarnation === record.coordinatorIncarnation
      ) {
        return { kind: 'child', pid: record.coordinatorPid, incarnation: currentIncarnation };
      }
      childAbsent = childLiveness === 'absent' || currentIncarnation !== record.coordinatorIncarnation;
    }
    if (typeof record.sentinelPid !== 'number' || record.sentinelPid <= 0) {
      unknown = true;
      continue;
    }
    const incarnation = record.sentinelIncarnation;
    const currentIncarnation = typeof incarnation === 'string' ? ports.processIncarnation(record.sentinelPid) : null;
    const sentinelAbsent = currentIncarnation !== null && currentIncarnation !== incarnation;
    const liveness = sentinelAbsent ? 'absent' : ports.processLiveness(record.sentinelPid);
    if (liveness === 'alive') return 'alive';
    if (liveness === 'absent' && record.state === 'prepared' && !childAbsent && record.coordinatorPid === undefined) {
      preparedDead = true;
      continue;
    }
    if (liveness === 'unknown' || (!childAbsent && record.state !== 'exited' && record.state !== 'spawn-fenced'))
      unknown = true;
  }
  return unknown ? 'unknown' : preparedDead ? 'prepared-dead' : matched ? 'absent' : 'missing';
}
