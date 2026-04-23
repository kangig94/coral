import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from './json.js';

function readBridgeManifest(pluginRoot: string): unknown {
  try {
    const raw = readFileSync(join(pluginRoot, 'bridge', 'manifest.json'), 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function readBundleHash(pluginRoot: string): string {
  const parsed = readBridgeManifest(pluginRoot);
  if (isRecord(parsed) && typeof parsed.bundleHash === 'string') {
    return parsed.bundleHash;
  }
  return 'unknown';
}

export function readBuildFlavor(pluginRoot: string): 'prod' | 'dev' {
  const parsed = readBridgeManifest(pluginRoot);
  return isRecord(parsed) && parsed.flavor === 'dev' ? 'dev' : 'prod';
}
