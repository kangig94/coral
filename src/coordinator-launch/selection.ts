import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import { createForeignTargetValidator } from '../infra/handoff-target.js';
import { createPluginRegistry } from '../infra/plugin-registry.js';
import { compareProductVersions } from '../infra/product-version.js';

export function validatedBuild(root: string): StrictBundleManifest | null {
  const bundleDir = join(root, 'bridge');
  const adjacent = readBoundedAdjacentManifest(bundleDir);
  if (!adjacent.ok) return null;
  const parsed = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!parsed.success || createForeignTargetValidator()(bundleDir, parsed.data).kind !== 'validated') return null;
  if (!existsSync(join(bundleDir, 'coral-sentinel.cjs')) || !existsSync(join(bundleDir, 'coral-backend.cjs')))
    return null;
  return parsed.data;
}

/** Find validated installed and retained roots; the caller applies controller eligibility before choosing. */
export function relaunchRoots(runDir: string, original: StrictBundleManifest | null): string[] {
  let installedRoots: string[];
  try {
    installedRoots = createPluginRegistry().installedPluginRoots('coral');
  } catch {
    installedRoots = [];
  }
  const installed = installedRoots
    .map((root) => ({ root, manifest: validatedBuild(root) }))
    .filter((entry): entry is { root: string; manifest: StrictBundleManifest } => entry.manifest !== null)
    .filter((entry) => original === null || entry.manifest.flavor === original.flavor)
    .sort((a, b) => compareProductVersions(b.manifest.version, a.manifest.version))
    .map((entry) => entry.root);
  if (original !== null) {
    const retained = join(dirname(runDir), 'builds', original.buildSetId);
    if (
      validatedBuild(retained) !== null &&
      createForeignTargetValidator()(join(retained, 'bridge'), original).kind === 'validated'
    )
      installed.push(retained);
  }
  return [...new Set(installed)];
}
