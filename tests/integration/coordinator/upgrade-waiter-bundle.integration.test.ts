import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CURRENT_STRICT_BUNDLE_MANIFEST_FILE,
  SUCCESSION_CAPABILITIES_FILE,
  UPGRADE_WAITER_BUNDLE_FILE,
} from '#src/infra/bundle-manifest-address.js';
import { strictBundleManifestSchema } from '#src/infra/bundle-manifest.js';
import { readSuccessionCapabilities } from '#src/coordinator/succession/protocol.js';
import { assertLifecycleBundleSetFresh } from '#tests/support/bundle-build-freshness.js';

describe('upgrade waiter bundle', () => {
  it('ships the waiter and a declared succession capability beside the target backend', () => {
    assertLifecycleBundleSetFresh();
    const bundleDir = join(process.cwd(), 'clients', 'build');
    const waiter = readFileSync(join(bundleDir, UPGRADE_WAITER_BUNDLE_FILE));
    const manifest = strictBundleManifestSchema.parse(
      JSON.parse(readFileSync(join(bundleDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')),
    );
    const packageFiles = JSON.parse(readFileSync('package.json', 'utf8')).files as string[];

    expect(waiter.length).toBeGreaterThan(0);
    expect(readSuccessionCapabilities(bundleDir, manifest)).toMatchObject({
      kind: 'declared',
      capabilities: { protocols: ['prepare', 'commit'] },
    });
    expect(packageFiles).toContain(`clients/bridge/${UPGRADE_WAITER_BUNDLE_FILE}`);
    expect(packageFiles).toContain(`clients/bridge/${SUCCESSION_CAPABILITIES_FILE}`);
  });
});
