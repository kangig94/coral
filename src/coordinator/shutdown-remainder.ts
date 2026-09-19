import { join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import { thrownErrnoCode } from '../infra/error-format.js';
import type { StoragePort, TimePort } from '../infra/port-types.js';
import {
  classifyShutdownRemainderFile,
  scanShutdownRemainderRecords,
  SHUTDOWN_REMAINDER_RECORD_VERSION,
  shutdownRemainderRecordDirectory,
  type ShutdownRemainderRecord,
  type ShutdownRemainderRecordScan,
} from '../infra/shutdown-remainder-record.js';
import { nowIsoString } from '../infra/time.js';
import type { ShutdownMode, ShutdownReason } from '../infra/persisted-scalar-contracts.js';
import type { ShutdownUndischarged } from './shutdown-settlement.js';

const MAX_SHUTDOWN_REMAINDER_RECORDS = 32;

type ShutdownRemainderReadRuntime = Readonly<{
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync'>;
  runDir: string;
}>;

type ShutdownRemainderPruneRuntime = Readonly<{
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'statSync' | 'unlinkSync'>;
  runDir: string;
}>;

type ShutdownRemainderWriteRuntime = Readonly<{
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
}>;

export type ShutdownRemainderStatus = Readonly<{
  version: typeof SHUTDOWN_REMAINDER_RECORD_VERSION;
  records: readonly ShutdownRemainderRecord[];
}>;

export type ShutdownRemainderStatusRead =
  | Readonly<{
      kind: 'available';
      path: string;
      status: ShutdownRemainderStatus;
      skippedEntries: ShutdownRemainderRecordScan['skippedEntries'];
      skippedRecords: ShutdownRemainderRecordScan['skippedRecords'];
    }>
  | Readonly<{ kind: 'absent'; path: string }>
  | Readonly<{ kind: 'unreadable'; path: string; detail: string }>;

export type ShutdownRemainderRecordInput = Readonly<{
  instanceId: string;
  reason: ShutdownReason;
  mode: ShutdownMode;
  undischarged: readonly ShutdownUndischarged[];
}>;

export function shutdownRemainderPath(runDir: string): string {
  return shutdownRemainderRecordDirectory(runDir);
}

export function readShutdownRemainderStatus(runtime: ShutdownRemainderReadRuntime): ShutdownRemainderStatusRead {
  const path = shutdownRemainderPath(runtime.runDir);
  if (!runtime.storage.existsSync(path)) return { kind: 'absent', path };
  try {
    const scan = scanShutdownRemainderRecords(runtime.storage, path);

    return {
      kind: 'available',
      path,
      status: { version: SHUTDOWN_REMAINDER_RECORD_VERSION, records: scan.records },
      skippedEntries: scan.skippedEntries,
      skippedRecords: scan.skippedRecords,
    };
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

type RecordAge = Readonly<{ kind: 'known'; mtimeMs: number }> | Readonly<{ kind: 'unknown' }>;

// Newest-known-first, with every 'unknown' age ranked older than any known mtime: a file this build could not
// stat carries no age evidence to assert a real age from, but still needs the same bounded-retention exit as
// every other unreadable file (design-philosophy.md principle 11/12), so it is the first to fall outside the
// retained window once the bound is exceeded rather than being exempted from the bound entirely.
function byRetentionOrder(
  left: Readonly<{ name: string; age: RecordAge }>,
  right: Readonly<{ name: string; age: RecordAge }>,
): number {
  if (left.age.kind === 'known' && right.age.kind === 'known') {
    return right.age.mtimeMs - left.age.mtimeMs || right.name.localeCompare(left.name);
  }
  if (left.age.kind !== right.age.kind) return left.age.kind === 'known' ? -1 : 1;
  return right.name.localeCompare(left.name);
}

export function pruneShutdownRemainderRecords(runtime: ShutdownRemainderPruneRuntime): void {
  const directory = shutdownRemainderPath(runtime.runDir);
  try {
    const known: { name: string; age: RecordAge }[] = [];
    const unreadable: { name: string; age: RecordAge }[] = [];
    for (const name of runtime.storage.readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
      const path = join(directory, name);
      let age: RecordAge = { kind: 'unknown' };
      try {
        age = { kind: 'known', mtimeMs: runtime.storage.statSync(path).mtimeMs };
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
      }

      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') continue;
      if (classification.kind === 'undecodable') {
        // Constraint: a decisive decode failure (design-philosophy.md principle 11) authorizes reclaiming this
        // file regardless of age — it is deleted outright rather than competing for a slot in the retention
        // count below.
        try {
          runtime.storage.unlinkSync(path);
          backendLog.warn(`shutdown remainder record ${name} discarded: content is not a decodable record`);
        } catch {
          /* Retention cleanup must not block startup. */
        }
        continue;
      }
      if (classification.kind === 'unreadable') {
        // Constraint: a record this build cannot prove readable is not proven old or content-invalid, and
        // unknown must not authorize deletion by content (design-philosophy.md principle 11). It competes only
        // against other unreadable files for the bounded slot count below — never against a known-readable
        // record — so persistent unreadability cannot displace genuinely decodable evidence out of its cap.
        unreadable.push({ name, age });
        continue;
      }
      // Constraint: a decodable record whose age this build could not establish (`statSync` and
      // `readFileSync` are independent syscalls, so one can fail transiently while the other succeeds) is
      // still evidence, not an unknown to discard (design-philosophy.md principle 11) — it joins `known`
      // rather than falling outside every retention bound, and `byRetentionOrder` ranks it as the oldest
      // entry in that bucket for exactly this reason.
      known.push({ name, age });
    }
    known.sort(byRetentionOrder);
    for (const { name } of known.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
      } catch {
        /* Retention cleanup must not block startup. */
      }
    }
    unreadable.sort(byRetentionOrder);
    // Constraint: this retention bound is the unreadable hold's only exit (design-philosophy.md principle 11 —
    // every hold names what ends it; principle 12 — no state may wait on an operator who is not there), for
    // every unreadable file including one this build could not even stat: `byRetentionOrder` ranks it as the
    // oldest, so it is reclaimed first once the bucket exceeds this same bound, without asserting anything
    // about its actual age.
    for (const { name } of unreadable.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
        backendLog.warn(
          `shutdown remainder record ${name} discarded: persistently unreadable beyond the retention bound`,
        );
      } catch {
        /* Retention cleanup must not block startup. */
      }
    }
  } catch {
    /* Retention cleanup must not block startup. */
  }
}

export function recordShutdownRemainder(
  runtime: ShutdownRemainderWriteRuntime,
  input: ShutdownRemainderRecordInput,
): boolean {
  const directory = shutdownRemainderPath(runtime.runDir);
  const path = join(directory, `${input.instanceId}.json`);
  const record: ShutdownRemainderRecord = {
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    reason: input.reason,
    mode: input.mode,
    entries: input.undischarged,
  };
  runtime.storage.mkdirSync(directory, { recursive: true });
  // Constraint: do not use `writeAtomicDurableSync`; `docs/design-rationale.md` §12.5 excludes its unbounded
  // journal commit waits from the coordinator exit path.
  return runtime.storage.writeAtomicSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
