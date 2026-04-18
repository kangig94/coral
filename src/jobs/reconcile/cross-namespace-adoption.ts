import { join } from 'node:path';
import { formatError, isNoEntryError, isRecord } from '../../shared/utils.js';
import { isLivePhase, readBackendNamespace, type PersistedStatusRecord } from '../../shared/types.js';
import type { Runtime } from '../../runtime/ports.js';
import {
  claimPathForStatus,
  readAdoptionStatusSnapshot,
  removeAdoptionClaimIfOwner,
  restoreVerifiedStagedStatus,
  stageVerifiedStatusSnapshot,
  tryAcquireAdoptionClaim,
  unlinkIfPresent,
} from './claim-protocol.js';

const FOREIGN_DAEMON_LOCK_STALE_MS = 30_000;

/**
 * Adopt orphaned jobs from other namespaces whose daemon has died.
 *
 * When a plugin updates (e.g. 0.5.0→0.5.1), the plugin root path changes,
 * causing a namespace hash change. Jobs from the old namespace are invisible
 * to the new ProgressStore. This function runs BEFORE hydration to rebind
 * orphaned live jobs to the current namespace on disk.
 *
 * Safety: only adopts if the foreign namespace's daemon is confirmed dead
 * (backend.json missing or PID not alive). Jobs from live daemons (e.g.
 * a dev-flavor daemon during a prod upgrade) are never touched.
 */
export function adoptOrphanedCrossNamespaceJobs(
  currentNamespace: string,
  runtime: Pick<Runtime, 'storage' | 'paths' | 'process' | 'time' | 'ids'>,
  log: (message: string) => void,
): number {
  let adopted = 0;
  const jobsDir = runtime.paths.jobsDir();

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = runtime.storage.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const statusPath = join(jobsDir, entry.name, 'status.json');
    const snapshot = readAdoptionStatusSnapshot(statusPath, runtime.storage);
    if (snapshot === null) continue;

    const { raw: verifiedStatusRaw, record } = snapshot;
    const foreignNs = readBackendNamespace(record);
    if (foreignNs === null || foreignNs === currentNamespace) continue;
    if (!isLivePhase(record.phase)) continue;

    if (isForeignDaemonAlive(foreignNs, runtime)) continue;

    const claim = tryAcquireAdoptionClaim(statusPath, verifiedStatusRaw, runtime);
    if (claim === null) continue;

    try {
      const confirmedSnapshot = readAdoptionStatusSnapshot(statusPath, runtime.storage);
      if (confirmedSnapshot === null || confirmedSnapshot.raw !== verifiedStatusRaw) continue;
      if (!isLivePhase(confirmedSnapshot.record.phase)) continue;

      const confirmedNamespace = readBackendNamespace(confirmedSnapshot.record);
      if (confirmedNamespace !== foreignNs) continue;

      if (!stageVerifiedStatusSnapshot(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage)) continue;

      if (isForeignDaemonAlive(foreignNs, runtime)) {
        restoreVerifiedStagedStatus(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage);
        continue;
      }

      const rebound: PersistedStatusRecord = {
        ...confirmedSnapshot.record,
        backendNamespace: currentNamespace,
      };
      const published = runtime.storage.tryExclusiveWriteSync(statusPath, JSON.stringify(rebound, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      if (!published) {
        restoreVerifiedStagedStatus(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage);
        continue;
      }

      unlinkIfPresent(claim.stagedPath, runtime.storage);
      adopted++;
      log(`Adopted orphaned job ${entry.name} from namespace ${foreignNs}\n`);
    } catch (error: unknown) {
      restoreVerifiedStagedStatus(statusPath, claim.stagedPath, verifiedStatusRaw, runtime.storage);
      log(`Failed to adopt orphaned job ${entry.name}: ${formatError(error)}\n`);
    } finally {
      removeAdoptionClaimIfOwner(claimPathForStatus(statusPath), claim.ownerId, runtime.storage);
    }
  }

  return adopted;
}

function isForeignDaemonAlive(
  foreignNamespace: string,
  runtime: Pick<Runtime, 'storage' | 'paths' | 'process' | 'time'>,
): boolean {
  const installDir = runtime.paths.installationDirForNamespace(foreignNamespace);
  const infoPath = join(installDir, 'backend.json');
  const lockPath = join(installDir, 'backend.lock');

  let backendRecord: { pid: number; instanceId: string } | null = null;
  try {
    const raw = runtime.storage.readFileSync(infoPath, 'utf-8');
    const info: unknown = JSON.parse(raw);
    if (
      isRecord(info) &&
      typeof info.pid === 'number' &&
      Number.isFinite(info.pid) &&
      typeof info.instanceId === 'string' &&
      info.instanceId.length > 0
    ) {
      backendRecord = { pid: info.pid, instanceId: info.instanceId };
    }
  } catch {
    backendRecord = null;
  }

  let lockMissing = false;
  let lockFresh = false;
  let lockRecord: { pid: number; instanceId: string } | null = null;
  try {
    const raw = runtime.storage.readFileSync(lockPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const ageMs = runtime.time.now() - runtime.storage.statSync(lockPath).mtimeMs;
    lockFresh = ageMs <= FOREIGN_DAEMON_LOCK_STALE_MS;
    if (
      isRecord(parsed) &&
      typeof parsed.pid === 'number' &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.instanceId === 'string' &&
      parsed.instanceId.length > 0
    ) {
      lockRecord = { pid: parsed.pid, instanceId: parsed.instanceId };
    }
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      lockMissing = true;
    } else {
      return true;
    }
  }

  if (backendRecord === null) {
    return !lockMissing && lockFresh;
  }

  if (lockMissing || !lockFresh || lockRecord === null) {
    return false;
  }

  if (backendRecord.instanceId !== lockRecord.instanceId || backendRecord.pid !== lockRecord.pid) {
    return false;
  }

  return runtime.process.isAlive(backendRecord.pid);
}
