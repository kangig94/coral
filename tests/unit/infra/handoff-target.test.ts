import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { createForeignTargetValidator, withValidatedHandoffTarget } from '#src/infra/handoff-target.js';

const roots: string[] = [];
const backendBundle = 'foreign backend fixture';
const cliBundle = 'foreign cli fixture';
const claudeAppserverBundle = 'foreign claude appserver fixture';
const durableWrapperBundle = 'foreign durable wrapper fixture';
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
  durableWrapperBundleHash: createHash('sha256').update(durableWrapperBundle).digest('hex').slice(0, 16),
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};

function createBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-handoff-target-'));
  roots.push(root);
  writeFileSync(join(root, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(root, 'coral-cli'), cliBundle, 'utf8');
  writeFileSync(join(root, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(root, 'coral-durable-wrapper.cjs'), durableWrapperBundle, 'utf8');
  writeFileSync(join(root, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest), 'utf8');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff-target', () => {
  it('should reject a byte mismatch at the final re-hash', () => {
    const bundleDir = createBundle();
    const result = createForeignTargetValidator()(bundleDir, manifest);
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') return;
    writeFileSync(join(bundleDir, 'coral-cli'), 'changed after validation', 'utf8');

    const execution = withValidatedHandoffTarget(result.target);
    expect(() => execution.assertExecutable()).toThrow('bytes changed before execution');
  });
});
