import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { createForeignTargetValidator } from '../infra/handoff-target.js';

export function validatedExecutable(executable: string): StrictBundleManifest | null {
  const bundleDir = dirname(executable);
  const adjacent = readBoundedAdjacentManifest(bundleDir);
  if (!adjacent.ok) return null;
  const manifest = strictBundleManifestSchema.safeParse(adjacent.value);
  return manifest.success &&
    createForeignTargetValidator()(bundleDir, manifest.data).kind === 'validated' &&
    existsSync(executable)
    ? manifest.data
    : null;
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
