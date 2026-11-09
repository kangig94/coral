import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import { errorMessage } from '../infra/error-format.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { createForeignTargetValidator } from '../infra/handoff-target.js';

export type ExecutableRefusal = Readonly<{ kind: 'refused'; executable: string; reason: string }>;

export type ExecutableAdmission =
  | Readonly<{ kind: 'admitted'; executable: string; manifest: StrictBundleManifest }>
  | ExecutableRefusal;

type ExecutableInspection =
  | Readonly<{ kind: 'valid'; manifest: StrictBundleManifest }>
  | Readonly<{ kind: 'invalid'; reason: string }>;

function inspectExecutable(executable: string): ExecutableInspection {
  const bundleDir = dirname(executable);
  const adjacent = readBoundedAdjacentManifest(bundleDir);
  if (!adjacent.ok) return { kind: 'invalid', reason: `bundle manifest ${adjacent.reason}` };
  const manifest = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!manifest.success) return { kind: 'invalid', reason: 'bundle manifest invalid' };
  const target = createForeignTargetValidator()(bundleDir, manifest.data);
  if (target.kind !== 'validated') return { kind: 'invalid', reason: `bundle target ${target.evidence.failure}` };
  if (!existsSync(executable)) return { kind: 'invalid', reason: 'executable missing' };
  return { kind: 'valid', manifest: manifest.data };
}

export function validatedExecutable(executable: string): StrictBundleManifest | null {
  const inspected = inspectExecutable(executable);
  return inspected.kind === 'valid' ? inspected.manifest : null;
}

/** Validation and execution must name the same resolved bundle directory. */
export function admitSupervisorExecutable(executable: string): ExecutableAdmission {
  let canonical: string;
  try {
    canonical = join(realpathSync(dirname(executable)), basename(executable));
  } catch (error: unknown) {
    return { kind: 'refused', executable, reason: `executable unresolvable: ${errorMessage(error)}` };
  }
  const inspected = inspectExecutable(canonical);
  return inspected.kind === 'valid'
    ? { kind: 'admitted', executable: canonical, manifest: inspected.manifest }
    : { kind: 'refused', executable, reason: inspected.reason };
}

export function targetValidation(executable: string): 'absent' | 'indeterminate' | StrictBundleManifest {
  try {
    if (!statSync(executable).isFile()) return 'indeterminate';
  } catch (error: unknown) {
    if (isNoEntryError(error)) return 'absent';
    return 'indeterminate';
  }
  return validatedExecutable(executable) ?? 'indeterminate';
}
