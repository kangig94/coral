import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import { isRecord } from './json.js';

declare const __BUNDLE_DIR__: string | undefined;

function bundleDir(): string | null {
  return typeof __BUNDLE_DIR__ === 'string' && __BUNDLE_DIR__.length > 0 ? __BUNDLE_DIR__ : null;
}

function readBundleManifest(pluginRoot: string): unknown {
  const activeBundleDir = bundleDir();
  const candidates = [
    ...(activeBundleDir === null ? [] : [join(activeBundleDir, 'manifest.json')]),
    join(pluginRoot, 'bridge', 'manifest.json'),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as unknown;
    } catch {
      // Try the plugin-root bridge manifest before failing open.
    }
  }
  return null;
}

export function readBundleHash(pluginRoot: string): string {
  const parsed = readBundleManifest(pluginRoot);
  if (isRecord(parsed) && typeof parsed.bundleHash === 'string') {
    return parsed.bundleHash;
  }
  return 'unknown';
}

export function readBuildFlavor(pluginRoot: string): BuildFlavor {
  const parsed = readBundleManifest(pluginRoot);
  return isRecord(parsed) && parsed.flavor === 'dev' ? 'dev' : 'prod';
}
