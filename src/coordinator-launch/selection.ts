import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { validatedBuild } from '../infra/installed-build-root.js';
import { createPluginRegistry } from '../infra/plugin-registry.js';
import { compareProductVersions } from '../infra/product-version.js';

export function relaunchRoots(original: StrictBundleManifest | null): string[] {
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
  return [...new Set(installed)];
}
