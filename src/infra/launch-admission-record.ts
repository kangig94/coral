import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { isNoEntryError } from './fs-errors.js';
import { probeProcessIncarnation, processIncarnationSchema } from './node-process.js';

const processSchema = z.object({ pid: z.number().int().positive(), incarnation: processIncarnationSchema });
const admissionSchema = z
  .object({
    version: z.literal(1),
    launchId: z.string().uuid(),
    child: processSchema,
    parent: processSchema,
    admittedAt: z.number().int().positive(),
    discoveredAt: z.number().int().positive().optional(),
    build: z.object({
      version: z.string().min(1),
      buildSetId: z.string().min(1),
      bundleHash: z.string().min(1),
      flavor: z.enum(['prod', 'dev']),
    }),
    purpose: z.enum(['startup', 'contender', 'succession', 'recovery', 'legacy-retirement']),
  })
  .passthrough();

export type LaunchAdmission = z.infer<typeof admissionSchema>;
export type LaunchAdmissionRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'readable'; admission: LaunchAdmission }>
  | Readonly<{ kind: 'unreadable'; path: string }>;

export function launchAdmissionPath(runDir: string, launchId: string): string {
  return join(runDir, 'launch-admissions.v1', `${z.string().uuid().parse(launchId)}.json`);
}

/** Called by the admitted child before it can enter coordinator startup. */
export function publishLaunchAdmission(runDir: string, admission: LaunchAdmission): void {
  const path = launchAdmissionPath(runDir, admission.launchId);
  const dir = join(runDir, 'launch-admissions.v1');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(admissionSchema.parse(admission)), { mode: 0o600, flag: 'wx' });
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const directory = openSync(dir, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error: unknown) {
    try {
      unlinkSync(temporary);
    } catch {
      /* The temporary file may not exist. */
    }
    throw error;
  }
}

export function readLaunchAdmission(runDir: string, launchId: string): LaunchAdmissionRead {
  let path: string;
  try {
    path = launchAdmissionPath(runDir, launchId);
  } catch {
    return { kind: 'unreadable', path: join(runDir, 'launch-admissions.v1') };
  }
  try {
    const admission = admissionSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return admission.launchId === launchId ? { kind: 'readable', admission } : { kind: 'unreadable', path };
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'absent' } : { kind: 'unreadable', path };
  }
}

export function listLaunchAdmissions(runDir: string): readonly LaunchAdmissionRead[] {
  let names: string[];
  try {
    names = readdirSync(join(runDir, 'launch-admissions.v1'));
  } catch (error: unknown) {
    return isNoEntryError(error) ? [] : [{ kind: 'unreadable', path: join(runDir, 'launch-admissions.v1') }];
  }
  return names.filter((name) => name.endsWith('.json')).map((name) => readLaunchAdmission(runDir, name.slice(0, -5)));
}

/** Only the child that published this identity may remove it. */
export function removeOwnLaunchAdmission(runDir: string, launchId: string): void {
  const observed = readLaunchAdmission(runDir, launchId);
  if (
    observed.kind !== 'readable' ||
    observed.admission.child.pid !== process.pid ||
    observed.admission.child.incarnation !== probeProcessIncarnation(process.pid)
  )
    return;
  try {
    unlinkSync(launchAdmissionPath(runDir, launchId));
  } catch (error: unknown) {
    if (!isNoEntryError(error)) throw error;
  }
}
