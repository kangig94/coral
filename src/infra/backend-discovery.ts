import { dirname } from 'node:path';
import { z } from 'zod';

import type { BuildFlavor } from './build-flavor.js';
import type { CoralPaths } from './path/index.js';
import type { EnvPort, StoragePort } from './port-types.js';
import {
  observeProcessLiveness,
  processIncarnationSchema,
  probeProcessIncarnation,
  type ProcessIncarnation,
} from './node-process.js';
import { backendLog } from './backend-log.js';
import { isNoEntryError } from './fs-errors.js';

/** Connection and authentication evidence only; executable identity comes from authenticated health. */
export interface CoordinatorDiscoveryRecord {
  pid: number;
  port: number;
  socketPath: string;
  bundleHash: string;
  flavor: BuildFlavor;
  namespace: string;
  startedAt: number;
  token: string;
  bootToken: string;
  shutdownToken?: string;
  host?: string;
  version?: string;
  instanceId?: string;
  incarnation?: ProcessIncarnation;
}

export interface BackendInfo extends CoordinatorDiscoveryRecord {
  host: string;
  version: string;
  instanceId: string;
}

type DiscoveryStorage = Pick<
  StoragePort,
  'chmodSync' | 'mkdirSync' | 'readFileSync' | 'unlinkSync' | 'writeAtomicSync'
>;
type DiscoveryEnv = Pick<EnvPort, 'platform'>;
export type DiscoveryRuntime = {
  storage: DiscoveryStorage;
  env: DiscoveryEnv;
  paths: { readonly coral: CoralPaths };
};

/** Where a record that names no host is assumed to be listening. */
export const DEFAULT_DISCOVERY_HOST = '127.0.0.1';

const nonEmptyStringSchema = z.string().min(1);
const positiveIntegerSchema = z.number().int().positive();
const coordinatorDiscoveryRecordSchema = z
  .object({
    pid: positiveIntegerSchema,
    port: positiveIntegerSchema,
    socketPath: nonEmptyStringSchema,
    bundleHash: nonEmptyStringSchema,
    flavor: z.enum(['prod', 'dev']),
    namespace: nonEmptyStringSchema,
    startedAt: z.number().positive(),
    token: nonEmptyStringSchema,
    bootToken: nonEmptyStringSchema,
    shutdownToken: nonEmptyStringSchema.optional(),
    host: nonEmptyStringSchema.optional(),
    version: nonEmptyStringSchema.optional(),
    instanceId: nonEmptyStringSchema.optional(),
    incarnation: processIncarnationSchema.optional(),
  })
  // A build older than a future field must still read this record — `.strict()` would make that build's
  // `probeCoordinator` reject it outright the day a newer writer adds one, when every field it already
  // knows about is still present and valid.
  .passthrough();

function normalizeDiscoveryRecord(value: unknown): CoordinatorDiscoveryRecord | null {
  const parsed = coordinatorDiscoveryRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function discoveryFilePath(runtime: DiscoveryRuntime): string {
  return runtime.paths.coral.coordinator.infoFile;
}

export function writeDiscoveryRecord(record: CoordinatorDiscoveryRecord, runtime: DiscoveryRuntime): void {
  const infoPath = discoveryFilePath(runtime);
  const incarnation =
    record.incarnation ?? probeProcessIncarnation(record.pid, runtime.env.platform() as NodeJS.Platform) ?? undefined;
  if (incarnation === undefined) {
    // Said out loud because the consequence arrives much later and looks like something else: a contender can
    // only signal a pid whose incarnation the incumbent published, so a record written without one leaves this
    // daemon replaceable over IPC but not evictable by force. Probing our own pid should not fail; if it did,
    // an operator reading a later "cannot be proven to be it" refusal needs this line to connect the two.
    backendLog.warn(`Coordinator discovery record for pid ${record.pid} was written without a process incarnation.`);
  }
  const payload = JSON.stringify({ ...record, incarnation });

  runtime.storage.mkdirSync(dirname(infoPath), { recursive: true });
  if (!runtime.storage.writeAtomicSync(infoPath, payload, { encoding: 'utf-8', mode: 0o600 })) {
    return;
  }
  if (runtime.env.platform() !== 'win32') {
    try {
      runtime.storage.chmodSync(infoPath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}

/**
 * What the discovery file says, in the three shapes it can say it. Only `missing` is a statement
 * that no coordinator claimed this socket. `undecodable` is a file that exists and could not be read as a
 * record — truncated mid-write, or written by a build whose shape this one rejects — which says nothing about
 * whether a coordinator is running.
 *
 * A fourth outcome exists and is deliberately not a variant: this function throws when the file cannot be
 * opened at all (`EACCES`, `EIO`) or when `JSON.parse` fails with something other than a `SyntaxError`. Those
 * are not statements about the incumbent — they are this process being unable to read its own run directory —
 * and making them a variant would ask every caller to invent a policy for a condition none of them can act on.
 *
 * The coordinator paths are on startup, where failing loudly beats continuing on an unread file. The CLI
 * paths must each render it. A future caller that wraps this in a blanket `catch` reintroduces exactly the
 * collapse this type exists to end.
 */
export type DiscoveryRead =
  | Readonly<{ kind: 'record'; record: CoordinatorDiscoveryRecord }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'undecodable'; reason: 'corrupt-json' | 'shape-rejected' }>;

export function readDiscoveryRecordDisposition(runtime: DiscoveryRuntime): DiscoveryRead {
  let raw: string;
  try {
    raw = runtime.storage.readFileSync(discoveryFilePath(runtime), 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return { kind: 'missing' };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return { kind: 'undecodable', reason: 'corrupt-json' };
    throw error;
  }

  const record = normalizeDiscoveryRecord(parsed);
  return record === null ? { kind: 'undecodable', reason: 'shape-rejected' } : { kind: 'record', record };
}

/**
 * The record, or `null` for every reason there might not be one — deliberately not exported. Anything else
 * wants `readDiscoveryRecordDisposition`, and keeping this private is what makes that the only door.
 */
function readDiscoveryRecord(runtime: DiscoveryRuntime): CoordinatorDiscoveryRecord | null {
  const read = readDiscoveryRecordDisposition(runtime);
  return read.kind === 'record' ? read.record : null;
}

/**
 * The pid can be unobservable; so can the record itself.
 *
 * The record axis and the process axis fail independently, and neither one failing is the other one
 * answering. `readBackendInfo`'s `null` covers a missing file, an undecodable one, *and* a record omitting
 * `version`/`instanceId`, so anything gating on it reports a confident `not_running` from evidence it could
 * not read.
 *
 * Only an observed `'absent'` is an absence. There is no invariant test behind that sentence and one was
 * tried — see the rejection recorded in `tests/invariants/liveness-is-never-a-boolean.test.ts`. The rule is
 * held by these return types and by the tests that assert what each variant does, so a fourth site adding
 * itself is caught by review, not by a scan.
 */
export type CoordinatorProbe =
  /** A record exists and its pid names a live process. */
  | Readonly<{ kind: 'live'; record: CoordinatorDiscoveryRecord }>
  /** No record was written, or the recorded pid decisively names no process. Either is a real absence. */
  | Readonly<{ kind: 'absent' }>
  /**
   * Nothing here is proof of absence, from either input. `unreadable-record` is a file that exists and could
   * not be decoded; `unreadable-process` is a record whose pid could not be observed — that one carries its
   * record deliberately, because the record holds the `bootToken` a contender needs to ask an incumbent to
   * stand down, and discarding it over an unanswered probe is what makes "could not observe" read as "nobody
   * is there".
   */
  | Readonly<{ kind: 'unobservable'; reason: 'unreadable-record' }>
  | Readonly<{ kind: 'unobservable'; reason: 'unreadable-process'; record: CoordinatorDiscoveryRecord }>;

/**
 * The record's `incarnation` is not compared here.
 *
 * Rejecting the record discards the `bootToken`
 * beside it, and a contender without that token cannot ask the incumbent to stand down, so this
 * function must keep returning a record whose pid it cannot vouch for.
 *
 * That makes this a read, not an authorization. Comparing the recorded token belongs at the sites
 * that act on the pid, where a mismatch can refuse a signal without also destroying the credential
 * that makes a peaceful handoff possible.
 *
 * The probe is a cheap filter, and it reports rather than decides. Do not collapse it back for being
 * three-shaped.
 *
 * `observeProcessLiveness` rather than `probeProcessIncarnation`: liveness is the whole question here, it is
 * the answer this reader can reach alone, and it is one `kill(pid, 0)` where the incarnation probe would fork
 * subprocesses to derive a token this function discards.
 */
export function probeCoordinator(runtime: DiscoveryRuntime): CoordinatorProbe {
  const read = readDiscoveryRecordDisposition(runtime);
  if (read.kind === 'missing') return { kind: 'absent' };
  if (read.kind === 'undecodable') {
    // Said out loud because it is otherwise invisible and its consequence arrives elsewhere: a contender that
    // reads this as "no incumbent" starts a second coordinator beside a live one. The write path warns when it
    // cannot record an incarnation; the read path was silent about a file it could not read at all.
    backendLog.warn(
      `Coordinator discovery record could not be decoded (${read.reason}); treating the incumbent as unobservable, not absent.`,
    );
    return { kind: 'unobservable', reason: 'unreadable-record' };
  }

  const { record } = read;
  switch (observeProcessLiveness(record.pid)) {
    case 'alive':
      return { kind: 'live', record };
    case 'absent':
      return { kind: 'absent' };
    case 'unknown':
      return { kind: 'unobservable', reason: 'unreadable-process', record };
  }
}

export function writeBackendInfo(info: BackendInfo, runtime: DiscoveryRuntime): void {
  writeDiscoveryRecord(info, runtime);
}

export function readBackendInfo(runtime: DiscoveryRuntime): BackendInfo | null {
  const record = readDiscoveryRecord(runtime);
  if (!record || record.version === undefined || record.instanceId === undefined) {
    return null;
  }

  return {
    ...record,
    host: record.host ?? DEFAULT_DISCOVERY_HOST,
    version: record.version,
    instanceId: record.instanceId,
  };
}

/**
 * Delete the discovery record, but only when this caller is provably the one that wrote it.
 *
 * Every early return here is a refusal to delete, not a completed removal, and the distinction matters because
 * the file is how a contender finds an incumbent: removing one this process does not own retires somebody
 * else's coordinator from discovery while it is still serving. So the bar is attribution — a record that
 * cannot be read, or that names another `instanceId` (or, for a record predating that field, another token),
 * is left exactly where it is. `void` is honest here only because no caller can act on the difference: this
 * runs on the owner's own shutdown path, and a record it cannot claim is one it must not touch either way.
 */
export function removeBackendInfoIfOwner(owner: string, runtime: DiscoveryRuntime): void {
  const record = readDiscoveryRecord(runtime);
  if (!record) {
    return;
  }

  if (record.instanceId !== undefined) {
    if (record.instanceId !== owner) {
      return;
    }
  } else if (record.token !== owner) {
    return; // predates `instanceId`, and its token names another writer
  }

  try {
    runtime.storage.unlinkSync(discoveryFilePath(runtime));
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
}
