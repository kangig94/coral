import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { ResolvedStoreEpoch } from './epoch.js';

const lineageSchema = z.object({ version: z.literal('v1'), lineageId: z.string().uuid() }).passthrough();
const LINEAGE_FILE = '.coral-lineage.v1.json';

export function readOrCreateEpochKey(epoch: ResolvedStoreEpoch): string {
  const marker = join(epoch.path, LINEAGE_FILE);
  let lineage: z.infer<typeof lineageSchema>;
  try {
    lineage = lineageSchema.parse(JSON.parse(readFileSync(marker, 'utf8')) as unknown);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const value = { version: 'v1', lineageId: randomUUID() } as const;
    const stage = `${marker}.stage.${process.pid}.${randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = openSync(stage, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      linkSync(stage, marker);
      lineage = value;
    } catch (createError: unknown) {
      if (!(createError instanceof Error && 'code' in createError && createError.code === 'EEXIST')) {
        throw createError;
      }
      lineage = lineageSchema.parse(JSON.parse(readFileSync(marker, 'utf8')) as unknown);
    } finally {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(stage);
      } catch (unlinkError: unknown) {
        if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT')) {
          throw unlinkError;
        }
      }
    }
    const dirFd = openSync(epoch.path, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
  return `${lineage.lineageId}:${epoch.epoch}`;
}
