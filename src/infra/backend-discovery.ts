import { dirname } from 'node:path';
import { z } from 'zod';

import type { BuildFlavor } from './build-flavor.js';
import type { CoralPaths } from './path/index.js';
import type { EnvPort, StoragePort } from './port-types.js';
import { processIncarnationSchema, probeProcessIncarnation, type ProcessIncarnation } from './node-process.js';
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

const DEFAULT_DISCOVERY_HOST = '127.0.0.1';

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
  const payload = JSON.stringify({
    ...record,
    incarnation:
      record.incarnation ?? probeProcessIncarnation(record.pid, runtime.env.platform() as NodeJS.Platform) ?? undefined,
  });

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

export function readDiscoveryRecord(runtime: DiscoveryRuntime): CoordinatorDiscoveryRecord | null {
  try {
    const raw = runtime.storage.readFileSync(discoveryFilePath(runtime), 'utf-8');
    return normalizeDiscoveryRecord(JSON.parse(raw));
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/**
 * The record's `incarnation` is not compared here, and the reason is narrower than it once was.
 *
 * The old rationale — that the derived value carried a per-process clock term and so was not
 * comparable across processes — died with the token: two processes now derive the same bytes for the
 * same incarnation. What survives is the second half. Rejecting the record discards the `bootToken`
 * beside it, and a contender without that token cannot ask the incumbent to stand down, so this
 * function must keep returning a record whose pid it cannot vouch for.
 *
 * That makes this a read, not an authorization. Comparing the recorded token became possible with the
 * token and belongs at the sites that act on the pid, where a mismatch can refuse a signal without
 * also destroying the credential that makes a peaceful handoff possible.
 *
 * Nothing here acts on `pid`. This returns a token and a socket path, and a record whose pid was recycled is
 * safe to return only because of what the *signalling* sites do with it: `verifySignalTarget`
 * (`coordinator/handoff.ts`) requires the record's own incarnation to be present and to match a live probe,
 * and refuses otherwise. The IPC side is not the guarantee — a connect can succeed and its shutdown still
 * fail authentication — so do not read this paragraph as licence to relax that check.
 *
 * The probe still runs, but only as a cheap filter. It yields `null` for an absent process *and* for a
 * read, parse, or unsupported-platform failure, so this is "could not observe a process", not proof of
 * absence — nothing downstream may treat it as proof.
 */
export function probeCoordinator(runtime: DiscoveryRuntime): CoordinatorDiscoveryRecord | null {
  const record = readDiscoveryRecord(runtime);
  if (!record) {
    return null;
  }

  const live = probeProcessIncarnation(record.pid, runtime.env.platform() as NodeJS.Platform);
  return live === null ? null : record;
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
    return;
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
