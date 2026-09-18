import { join } from 'node:path';

import { thrownErrnoCode } from '../infra/error-format.js';
import type { StoragePort, TimePort } from '../infra/port-types.js';
import {
  scanShutdownRemainderRecords,
  SHUTDOWN_REMAINDER_RECORD_VERSION,
  shutdownRemainderRecordDirectory,
  type ShutdownRemainderRecord,
  type ShutdownRemainderRecordScan,
} from '../infra/shutdown-remainder-record.js';
import { nowIsoString } from '../infra/time.js';
import type { ShutdownMode, ShutdownReason } from './shutdown.js';
import type { ShutdownUndischarged } from './shutdown-settlement.js';

const MAX_SHUTDOWN_REMAINDER_RECORDS = 32;

type ShutdownRemainderReadRuntime = Readonly<{
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync'>;
  runDir: string;
}>;

type ShutdownRemainderPruneRuntime = Readonly<{
  storage: Pick<StoragePort, 'readdirSync' | 'statSync' | 'unlinkSync'>;
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

export function pruneShutdownRemainderRecords(runtime: ShutdownRemainderPruneRuntime): void {
  const directory = shutdownRemainderPath(runtime.runDir);
  try {
    const records: { name: string; mtimeMs: number }[] = [];
    for (const name of runtime.storage.readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
      try {
        records.push({ name, mtimeMs: runtime.storage.statSync(join(directory, name)).mtimeMs });
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
        // No production reader depends on this file's survival to discharge an obligation: status.ts's scan is
        // diagnostic display, and readShutdownRemainderStatus has no production caller at all. A record this
        // build cannot stat also cannot be ranked by the mtime sort below, so it is unlinked outright instead of
        // sitting outside that ranking, and outside this cap, forever.
        try {
          runtime.storage.unlinkSync(join(directory, name));
        } catch {
          /* Retention cleanup must not block startup. */
        }
      }
    }
    records.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    for (const { name } of records.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
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
