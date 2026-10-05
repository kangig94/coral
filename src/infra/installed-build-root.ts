import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from './bundle-manifest.js';
import { createForeignTargetValidator } from './handoff-target.js';
import { createPluginRegistry } from './plugin-registry.js';

export function validatedRunningBuildRoot(installedRoot: string, manifest: StrictBundleManifest): string | null {
  return createForeignTargetValidator()(join(installedRoot, 'bridge'), manifest).kind === 'validated'
    ? installedRoot
    : null;
}

export function validatedBuild(root: string): StrictBundleManifest | null {
  const bundleDir = join(root, 'bridge');
  const adjacent = readBoundedAdjacentManifest(bundleDir);
  if (!adjacent.ok) return null;
  const parsed = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!parsed.success || validatedRunningBuildRoot(root, parsed.data) === null) return null;
  if (!existsSync(join(bundleDir, 'coral-backend.cjs'))) return null;
  return parsed.data;
}

export function installedBuild(buildSetId: string): Readonly<{ root: string; manifest: StrictBundleManifest }> | null {
  let roots: string[];
  try {
    roots = createPluginRegistry().installedPluginRoots('coral');
  } catch {
    return null;
  }
  for (const root of roots) {
    const manifest = validatedBuild(root);
    if (manifest !== null && manifest.buildSetId === buildSetId) return { root, manifest };
  }
  return null;
}
