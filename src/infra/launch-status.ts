import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { tryAcquireDiagnosticDirectoryLock } from './fs-lock.js';

const childSchema = z.object({ launchId: z.string().min(1), pid: z.number().int().positive() });
const statusSchema = z
  .object({
    version: z.literal(1),
    publicationFailure: z.object({ code: z.literal('status-publication-unavailable'), detail: z.string() }).optional(),
    admissionHolds: z
      .array(z.object({ path: z.string(), disposition: z.enum(['unknown', 'acquisition-window', 'cleanup-pending']) }))
      .optional(),
    previousStatus: z.literal('unavailable').optional(),
    inheritedHealth: z
      .array(
        z.object({
          launchId: z.string().min(1),
          supervisor: z.object({ pid: z.number().int().positive(), incarnation: z.string().min(1) }),
          child: z.object({ pid: z.number().int().positive(), incarnation: z.string().min(1) }),
          observedHealthyAt: z.number(),
        }),
      )
      .optional(),
    hold: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('no-eligible-build'),
          controller: z.string(),
          requestId: z.string().optional(),
          observation: z.string().optional(),
          retry: z.enum(['controller-evidence-change', 'eligible-build-appears']).optional(),
        }),
        z.object({
          kind: z.literal('custody-unreadable'),
          path: z.string(),
          observation: z.string().optional(),
          retry: z.literal('restore-readable-custody-record'),
        }),
        z.object({ kind: z.literal('target-indeterminate'), requestId: z.string() }),
        z.object({
          kind: z.literal('inherited-child-unresponsive'),
          launchId: z.string(),
          pid: z.number().int().positive(),
        }),
        z.object({ kind: z.literal('admission-unreadable'), path: z.string() }),
      ])
      .optional(),
    inheritedHolds: z
      .array(childSchema.extend({ incarnation: z.string().optional(), observation: z.string().optional() }))
      .default([]),
    signalHolds: z
      .array(
        childSchema.extend({
          incarnation: z.string().min(1),
          disposition: z.enum(['parent-identity-unknown', 'parent-silent']).optional(),
          observation: z.string().optional(),
        }),
      )
      .default([]),
    lockHold: z
      .object({
        path: z.string(),
        disposition: z.literal('supervisor-lock-unobservable'),
        observation: z.string(),
      })
      .optional(),
  })
  .passthrough();

export type LaunchStatus = z.infer<typeof statusSchema>;
export type LaunchStatusRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'readable'; status: LaunchStatus }>
  | Readonly<{ kind: 'unreadable' }>;

/** Optional diagnostics cannot reject serving health when their shape is unreadable. */
export function parseLaunchStatus(value: unknown): LaunchStatus | undefined {
  const parsed = statusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function readLaunchStatus(runDir: string): LaunchStatusRead {
  try {
    return {
      kind: 'readable',
      status: statusSchema.parse(JSON.parse(readFileSync(join(runDir, 'launch-status.v1.json'), 'utf8')) as unknown),
    };
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
}

type PendingStatus = {
  status: LaunchStatus;
  ownedFields: Set<string>;
  lists: Map<string, Map<string, unknown>>;
  retry: ReturnType<typeof setTimeout> | null;
};
const pendingStatuses = new Map<string, PendingStatus>();
const receivedStatuses = new Map<string, LaunchStatus>();

/** Publication failure must not erase current holds from serving health. */
export function currentLaunchStatus(runDir: string): LaunchStatus | undefined {
  const pending = pendingStatuses.get(runDir);
  const local = pending?.status;
  const remote = receivedStatuses.get(runDir);
  if (remote === undefined) return local;
  if (local === undefined) return remote;
  const currentHolds = (key: 'inheritedHolds' | 'signalHolds'): unknown[] => {
    const entries = indexedStatusList(remote[key]);
    for (const [id, value] of pending?.lists.get(key) ?? []) {
      if (value === undefined) entries.delete(id);
      else entries.set(id, value);
    }
    return [...entries.values()];
  };
  return statusSchema.parse({
    ...remote,
    ...Object.fromEntries([...(pending?.ownedFields ?? [])].map((key) => [key, local[key]])),
    ...(local.previousStatus !== undefined || remote.previousStatus !== undefined
      ? { previousStatus: 'unavailable' as const }
      : {}),
    publicationFailure: local.publicationFailure ?? remote.publicationFailure,
    inheritedHolds: currentHolds('inheritedHolds'),
    signalHolds: currentHolds('signalHolds'),
  });
}

/** Only authenticated launch and replacement channels may supply remote diagnostics. */
export function receiveLaunchStatus(runDir: string, value: unknown): void {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) return;
  receivedStatuses.set(runDir, parsed.data);
}

/** Diagnostic only. Its contents are never consulted when deciding whether to boot or signal. */
export function updateLaunchStatus(runDir: string, change: (current: LaunchStatus) => LaunchStatus): void {
  let pending = pendingStatuses.get(runDir);
  if (pending === undefined) {
    const observed = readLaunchStatus(runDir);
    pending = {
      status:
        observed.kind === 'readable'
          ? observed.status
          : statusSchema.parse({
              version: 1,
              ...(observed.kind === 'unreadable' ? { previousStatus: 'unavailable' } : {}),
            }),
      ownedFields: new Set(),
      lists: new Map(),
      retry: null,
    };
    pendingStatuses.set(runDir, pending);
  }
  const next = statusSchema.parse(change(pending.status));
  for (const key of new Set([...Object.keys(pending.status), ...Object.keys(next)])) {
    if (key === 'publicationFailure' || JSON.stringify(pending.status[key]) === JSON.stringify(next[key])) continue;
    if (['inheritedHolds', 'signalHolds', 'inheritedHealth', 'admissionHolds'].includes(key)) {
      const edits = pending.lists.get(key) ?? new Map<string, unknown>();
      const before = indexedStatusList(pending.status[key]);
      const after = indexedStatusList(next[key]);
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) edits.set(id, after.get(id));
      }
      pending.lists.set(key, edits);
    } else {
      pending.ownedFields.add(key);
    }
  }
  pending.status = next;
  if (pending.retry !== null) return;
  publishPendingStatus(runDir, pending);
}

function indexedStatusList(value: unknown): Map<string, unknown> {
  if (!Array.isArray(value)) return new Map();
  return new Map(
    value.map((entry: { launchId?: string; path?: string }) => [entry.launchId ?? entry.path ?? '', entry]),
  );
}

function publishPendingStatus(runDir: string, pending: PendingStatus): void {
  let release: ReturnType<typeof tryAcquireDiagnosticDirectoryLock> = null;
  try {
    release = tryAcquireDiagnosticDirectoryLock(join(runDir, 'launch-status.v1.lock'));
    if (release === null) throw new Error('Status serialization is contended or unobservable');
    const observed = readLaunchStatus(runDir);
    const base = observed.kind === 'readable' ? observed.status : pending.status;
    const merged = {
      ...base,
      ...Object.fromEntries([...pending.ownedFields].map((key) => [key, pending.status[key]])),
    };
    for (const key of ['inheritedHolds', 'signalHolds', 'inheritedHealth', 'admissionHolds']) {
      const edits = pending.lists.get(key) ?? new Map<string, unknown>();
      const entries = indexedStatusList(base[key]);
      for (const [id, value] of edits) {
        if (value === undefined) entries.delete(id);
        else entries.set(id, value);
      }
      merged[key] = [...entries.values()];
    }
    const next = statusSchema.parse({
      ...merged,
      publicationFailure: undefined,
      ...(observed.kind === 'unreadable' || pending.status.previousStatus !== undefined
        ? { previousStatus: 'unavailable' }
        : {}),
    });
    const path = join(runDir, 'launch-status.v1.json');
    const temporary = join(runDir, `.launch-status-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      const file = openSync(temporary, 'r');
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      release.assertOwned();
      renameSync(temporary, path);
      const directory = openSync(dirname(path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* Renamed or never created. */
      }
    }
    pending.status = next;
    if (pending.retry !== null) clearTimeout(pending.retry);
    pending.retry = null;
  } catch (error: unknown) {
    pending.status = {
      ...pending.status,
      publicationFailure: {
        code: 'status-publication-unavailable',
        detail: String(error),
      },
    };
    if (pending.retry === null) {
      pending.retry = setTimeout(() => {
        pending.retry = null;
        publishPendingStatus(runDir, pending);
      }, 200);
      pending.retry.unref();
    }
  } finally {
    release?.();
  }
}
