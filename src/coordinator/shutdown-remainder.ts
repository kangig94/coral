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
import type { ShutdownMode, ShutdownReason } from './shutdown.js';
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

export function pruneShutdownRemainderRecords(runtime: ShutdownRemainderPruneRuntime): void {
  const directory = shutdownRemainderPath(runtime.runDir);
  try {
    const known: { name: string; mtimeMs: number }[] = [];
    for (const name of runtime.storage.readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
      const path = join(directory, name);
      let mtimeMs: number | null = null;
      try {
        mtimeMs = runtime.storage.statSync(path).mtimeMs;
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
        mtimeMs = null;
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
      if (classification.kind === 'unreadable' || mtimeMs === null) {
        // Constraint: a record this build cannot prove readable, or cannot stat, is not proven old or
        // content-invalid, and unknown must not authorize deletion (design-philosophy.md principle 11). It is
        // excluded from the retention count entirely — ranking it as newest still counts it against the cap,
        // which evicts a genuinely newer known record in its place once enough unprovable files accumulate.
        continue;
      }
      known.push({ name, mtimeMs });
    }
    known.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    for (const { name } of known.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
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
