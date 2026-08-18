import {
  DEFAULT_DISCOVERY_HOST,
  readDiscoveryRecordDisposition,
  type CoordinatorDiscoveryRecord,
  type DiscoveryRuntime,
} from '../../../infra/backend-discovery.js';
import { observeProcessLiveness } from '../../../infra/node-process.js';
import type { CoralPaths } from '../../../infra/path/index.js';
import type { StoragePort } from '../../../infra/port-types.js';

/** A record whose `host` has been defaulted, so callers stop re-deriving it. */
export type AddressedCoordinator = CoordinatorDiscoveryRecord & { host: string };

/**
 * What `backend status` and `backend shutdown` both learn about the local coordinator before they diverge.
 *
 * Both ask the same questions in the same order — can the record be read, was one written (and if not, is a
 * coordinator mid-boot), is the recorded process still there. Answering them here rather than once per command
 * is what holds one observation to one vocabulary: two spellings of it drift apart a correction at a time,
 * because a fix lands on whichever command surfaced the defect and not on its twin.
 *
 * Each command still owns what it does *with* the answer: `status` folds absence into a startup-diagnostic
 * read, `shutdown` refuses before it ever dials. This type is the shared evidence, not the shared decision.
 */
export type CoordinatorObservation =
  /**
   * The record decoded and its pid was not observed absent. Everything either command needs is here.
   *
   * `pidLiveness` is the liveness this observation actually made, not a promise that `coordinator.pid` is the
   * process answering at the address: `'alive'` means that pid was directly confirmed; `'unknown'` means it
   * could not be observed either way, and the record was kept only because `unknown` is not `absent`. A caller
   * that later learns *something* answers at the address (a health probe, a 401) may not fold that back into
   * "so pid N is alive" — the two are independent observations, and only this field carries the second one.
   */
  | Readonly<{ kind: 'addressed'; coordinator: AddressedCoordinator; pidLiveness: 'alive' | 'unknown' }>
  /** The file exists and could not be read as a record. Not an absence, and the path is the remedy. */
  | Readonly<{ kind: 'unreadable-record'; reason: 'corrupt-json' | 'shape-rejected'; path: string }>
  /** No coordinator recorded itself, and its IPC socket file does not exist either. A real absence. */
  | Readonly<{ kind: 'no-record' }>
  /**
   * No record decoded, but the coordinator's own IPC socket file exists. `src/coordinator/lifecycle.ts` binds
   * that socket well before it publishes the discovery record, so a coordinator caught in that exact window
   * produces this; a socket file a coordinator left behind without unlinking it (a SIGKILL, an OOM kill)
   * produces the same evidence and cannot be told apart from a boot in progress. Neither reading may be folded
   * into `no-record`'s decisive absence.
   */
  | Readonly<{ kind: 'no-record-socket-present'; socketPath: string }>
  /**
   * A record names a pid that decisively no longer exists. Also a real absence.
   *
   * It carries both halves of the dead coordinator's identity because absence is where they are needed:
   * `status` reads a startup diagnostic to explain the absence, and a diagnostic is only this coordinator's if
   * it names this pid *and* was recorded no earlier than this run began. Dropping `startedAt` here left the pid
   * as the sole scope, and a pid is reused — so the recycled-pid case this pairing exists to exclude came back
   * silently, under a comment still claiming it was excluded.
   */
  | Readonly<{ kind: 'process-absent'; pid: number; startedAt: number }>;

export function observeCoordinator(
  runtime: DiscoveryRuntime & {
    paths: { readonly coral: CoralPaths };
    storage: Pick<StoragePort, 'existsSync'>;
  },
): CoordinatorObservation {
  const read = readDiscoveryRecordDisposition(runtime);
  if (read.kind === 'undecodable') {
    return { kind: 'unreadable-record', reason: read.reason, path: runtime.paths.coral.coordinator.infoFile };
  }
  if (read.kind === 'missing') {
    const socketPath = runtime.paths.coral.coordinator.socketPath;
    return runtime.storage.existsSync(socketPath)
      ? { kind: 'no-record-socket-present', socketPath }
      : { kind: 'no-record' };
  }

  // The decoded record rather than `readBackendInfo`: that helper also answers `null` when `version` or
  // `instanceId` is absent, and neither command reads either — between them they use `startedAt`, `pid`,
  // `host`, `port`, `namespace`, `flavor` and `bootToken`, all of which the record itself carries. Routing
  // through it reported a coordinator old enough to omit two unused fields as not running while it served.
  const record = read.record;
  // Only an observed absence is an absence. `unknown` keeps the record and lets the caller try, which is the
  // safe direction for both of them: status goes on to ask health, shutdown goes on to send the request.
  const liveness = observeProcessLiveness(record.pid);
  if (liveness === 'absent') {
    return { kind: 'process-absent', pid: record.pid, startedAt: record.startedAt };
  }
  return {
    kind: 'addressed',
    coordinator: { ...record, host: record.host ?? DEFAULT_DISCOVERY_HOST },
    pidLiveness: liveness,
  };
}
