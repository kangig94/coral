import {
  DEFAULT_DISCOVERY_HOST,
  readDiscoveryRecordDisposition,
  type CoordinatorDiscoveryRecord,
  type DiscoveryRuntime,
} from '../../../infra/backend-discovery.js';
import { observeProcessLiveness } from '../../../infra/node-process.js';
import type { CoralPaths } from '../../../infra/path/index.js';

/** A record whose `host` has been defaulted, so callers stop re-deriving it. */
export type AddressedCoordinator = CoordinatorDiscoveryRecord & { host: string };

/**
 * What `backend status` and `backend shutdown` both learn about the local coordinator before they diverge.
 *
 * The two commands ask the same three questions in the same order — can the record be read, was one written,
 * is the recorded process still there — and used to answer them separately. That produced two vocabularies for
 * one subject: `undecodable_record` here and `unreadable_record` there for the same two lines reading the same
 * file, with `reason` typed on one side and a free-form `detail` on the other, rendered by the same `coral-cli
 * backend` surface. Two spellings of one observation is how they drifted apart twice on this branch — one
 * command was corrected and the other was not, in both directions.
 *
 * Each command still owns what it does *with* the answer: `status` folds absence into a startup-diagnostic
 * read, `shutdown` refuses before it ever dials. This type is the shared evidence, not the shared decision.
 */
export type CoordinatorObservation =
  /** The record decoded and its pid was not observed absent. Everything either command needs is here. */
  | Readonly<{ kind: 'addressed'; coordinator: AddressedCoordinator }>
  /** The file exists and could not be read as a record. Not an absence, and the path is the remedy. */
  | Readonly<{ kind: 'unreadable-record'; reason: 'corrupt-json' | 'shape-rejected'; path: string }>
  /** No coordinator recorded itself. A real absence. */
  | Readonly<{ kind: 'no-record' }>
  /** A record names a pid that decisively no longer exists. Also a real absence, and it names the pid. */
  | Readonly<{ kind: 'process-absent'; pid: number }>;

export function observeCoordinator(
  runtime: DiscoveryRuntime & { paths: { readonly coral: CoralPaths } },
): CoordinatorObservation {
  const read = readDiscoveryRecordDisposition(runtime);
  if (read.kind === 'undecodable') {
    return { kind: 'unreadable-record', reason: read.reason, path: runtime.paths.coral.coordinator.infoFile };
  }
  if (read.kind === 'missing') {
    return { kind: 'no-record' };
  }

  // The decoded record rather than `readBackendInfo`: that helper also answers `null` when `version` or
  // `instanceId` is absent, and neither command reads either — between them they use `startedAt`, `pid`,
  // `host`, `port`, `namespace`, `flavor` and `bootToken`, all of which the record itself carries. Routing
  // through it reported a coordinator old enough to omit two unused fields as not running while it served.
  const record = read.record;
  // Only an observed absence is an absence. `unknown` keeps the record and lets the caller try, which is the
  // safe direction for both of them: status goes on to ask health, shutdown goes on to send the request.
  if (observeProcessLiveness(record.pid) === 'absent') {
    return { kind: 'process-absent', pid: record.pid };
  }
  return { kind: 'addressed', coordinator: { ...record, host: record.host ?? DEFAULT_DISCOVERY_HOST } };
}
