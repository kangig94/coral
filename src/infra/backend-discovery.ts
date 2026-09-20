import { dirname } from 'node:path';
import { z } from 'zod';

import type { BuildFlavor } from './build-flavor.js';
import type { CoralPaths } from './path/index.js';
import type { EnvPort, StoragePort } from './port-types.js';
import { MAX_PROCESS_INCARNATION_LENGTH, observeProcessLiveness, type ProcessIncarnation } from './node-process.js';
import { backendLog } from './backend-log.js';
import { serializeThrown, type SerializedThrown } from './error-format.js';
import { isNoEntryError } from './fs-errors.js';
import { sha256Hex } from './hash.js';
import type { Runtime } from '../runtime/ports.js';

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
  storeEpoch?: string;
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
export type DiscoveryWriterRuntime = DiscoveryRuntime & {
  process: Pick<Runtime['process'], 'readProcessIncarnation'>;
};

/** Where a record that names no host is assumed to be listening. */
export const DEFAULT_DISCOVERY_HOST = '127.0.0.1';

const nonEmptyStringSchema = z.string().min(1);
const positiveIntegerSchema = z.number().int().positive();
const durableProcessIncarnationSchema = z
  .string()
  .min(1)
  .max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>;
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
    incarnation: durableProcessIncarnationSchema.optional(),
    storeEpoch: z
      .string()
      .regex(/^[1-9]\d*$/u)
      .optional(),
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

export function writeDiscoveryRecord(record: CoordinatorDiscoveryRecord, runtime: DiscoveryWriterRuntime): boolean {
  const infoPath = discoveryFilePath(runtime);
  const incarnation =
    record.incarnation ??
    runtime.process.readProcessIncarnation(record.pid, runtime.env.platform() as NodeJS.Platform) ??
    undefined;
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
    return false;
  }
  if (runtime.env.platform() !== 'win32') {
    try {
      runtime.storage.chmodSync(infoPath, 0o600);
    } catch {
      // Best-effort.
    }
  }
  return true;
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

export type CoordinatorProbe =
  | Readonly<{ kind: 'live'; record: CoordinatorDiscoveryRecord }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unobservable'; reason: 'unreadable-record' }>
  | Readonly<{
      kind: 'unobservable';
      reason: 'unreadable-process' | 'recorded-process-absent';
      record: CoordinatorDiscoveryRecord;
    }>;

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
      return { kind: 'unobservable', reason: 'recorded-process-absent', record };
    case 'unknown':
      return { kind: 'unobservable', reason: 'unreadable-process', record };
  }
}

export function writeBackendInfo(info: BackendInfo, runtime: DiscoveryWriterRuntime): boolean {
  return writeDiscoveryRecord(info, runtime);
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

export type BackendInfoRemovalResult =
  | Readonly<{ kind: 'removed' }>
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{
      kind: 'refused';
      operation: 'read' | 'decode' | 'unlink';
      code: 'filesystem-operation-failed' | 'corrupt-json' | 'shape-rejected';
      correlation: string;
      error: SerializedThrown;
    }>;

function backendInfoRemovalRefusal(
  operation: 'read' | 'decode' | 'unlink',
  code: 'filesystem-operation-failed' | 'corrupt-json' | 'shape-rejected',
  error: unknown,
): Extract<BackendInfoRemovalResult, { kind: 'refused' }> {
  const serialized = serializeThrown(error);
  return {
    kind: 'refused',
    operation,
    code,
    correlation: sha256Hex(`${operation}\0${code}\0${JSON.stringify(serialized)}`),
    error: serialized,
  };
}

/**
 * Delete the discovery record, but only when this caller is provably the one that wrote it.
 *
 * The file is how a contender finds an incumbent, so a record that cannot be attributed to this owner must
 * remain in place. Operational failures are returned because shutdown must still release its other authority.
 */
export function removeBackendInfoIfOwner(owner: string, runtime: DiscoveryRuntime): BackendInfoRemovalResult {
  let read: DiscoveryRead;
  try {
    read = readDiscoveryRecordDisposition(runtime);
  } catch (error: unknown) {
    return backendInfoRemovalRefusal('read', 'filesystem-operation-failed', error);
  }
  if (read.kind === 'missing') return { kind: 'unchanged' };
  if (read.kind === 'undecodable') {
    return backendInfoRemovalRefusal('decode', read.reason, `record undecodable (${read.reason})`);
  }

  const { record } = read;

  if (record.instanceId !== undefined) {
    if (record.instanceId !== owner) {
      return { kind: 'unchanged' };
    }
  } else if (record.token !== owner) {
    return { kind: 'unchanged' }; // predates `instanceId`, and its token names another writer
  }

  try {
    runtime.storage.unlinkSync(discoveryFilePath(runtime));
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return { kind: 'unchanged' };
    }
    return backendInfoRemovalRefusal('unlink', 'filesystem-operation-failed', error);
  }
  return { kind: 'removed' };
}
