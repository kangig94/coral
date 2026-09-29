import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireDirectoryLockSync } from './fs-lock.js';

const childSchema = z.object({ launchId: z.string().min(1), pid: z.number().int().positive() });
const statusSchema = z
  .object({
    version: z.literal(1),
    hold: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('no-eligible-build'),
          controller: z.string(),
          retry: z.enum(['controller-evidence-change', 'eligible-build-appears']).optional(),
        }),
        z.object({
          kind: z.literal('custody-unreadable'),
          path: z.string(),
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
    inheritedHolds: z.array(childSchema).default([]),
    signalHolds: z.array(childSchema.extend({ incarnation: z.string().min(1) })).default([]),
  })
  .passthrough();

export type LaunchStatus = z.infer<typeof statusSchema>;
export type LaunchStatusRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'readable'; status: LaunchStatus }>
  | Readonly<{ kind: 'unreadable' }>;

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

/** Diagnostic only. Its contents are never consulted when deciding whether to boot or signal. */
export function updateLaunchStatus(runDir: string, change: (current: LaunchStatus) => LaunchStatus): void {
  const release = acquireDirectoryLockSync(join(runDir, 'launch-status.v1.lock'));
  try {
    const observed = readLaunchStatus(runDir);
    const current =
      observed.kind === 'readable' ? observed.status : { version: 1 as const, inheritedHolds: [], signalHolds: [] };
    const next = statusSchema.parse(change(current));
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
  } finally {
    release();
  }
}
