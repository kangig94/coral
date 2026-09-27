import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UpgradeIntent } from '../infra/upgrade-intent.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { UpgradeWaiterPorts } from '../runtime/upgrade-waiter.js';

type SpawnObservation =
  | 'absent'
  | 'alive'
  | 'unknown'
  | Readonly<{ kind: 'child'; pid: number; incarnation: ProcessIncarnation }>;

/** Sentinel records identify a launched target even if its waiter died before recording the child in the intent. */
export function observePendingSpawn(
  runDir: string,
  intent: UpgradeIntent,
  ports: Pick<UpgradeWaiterPorts, 'processIncarnation' | 'processLiveness'>,
): SpawnObservation {
  const directory = join(runDir, 'coordinator-sentinel.v1');
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
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
    if (record.state === 'exited') continue;
    if (typeof record.coordinatorPid === 'number' && record.coordinatorPid > 0) {
      const currentIncarnation = ports.processIncarnation(record.coordinatorPid);
      const childLiveness = ports.processLiveness(record.coordinatorPid);
      if (childLiveness === 'unknown') return 'unknown';
      if (childLiveness === 'alive' && currentIncarnation === null) return 'unknown';
      if (
        childLiveness === 'alive' &&
        currentIncarnation !== null &&
        currentIncarnation === record.coordinatorIncarnation
      ) {
        return { kind: 'child', pid: record.coordinatorPid, incarnation: currentIncarnation };
      }
    }
    if (typeof record.sentinelPid !== 'number' || record.sentinelPid <= 0) return 'unknown';
    const incarnation = record.sentinelIncarnation;
    const currentIncarnation = typeof incarnation === 'string' ? ports.processIncarnation(record.sentinelPid) : null;
    if (currentIncarnation !== null && currentIncarnation !== incarnation) continue;
    const liveness = ports.processLiveness(record.sentinelPid);
    if (liveness !== 'absent') return liveness;
  }
  return 'absent';
}
