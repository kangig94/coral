import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertLifecycleBundleSetFresh,
  lifecycleBundleSourceSha256,
  type BundleFreshnessReceiptV1,
} from '#tests/support/bundle-build-freshness.js';

const STALE_BUILD_DIAGNOSTIC = 'clients/build is stale; run npm run build:dev';
const INPUTS = [
  'package.json',
  'scripts/build-server.mjs',
  'scripts/server-esbuild-options.mjs',
  'src/example.ts',
  'tsconfig.json',
] as const;
const OUTPUTS = {
  backend: 'clients/build/coral-backend.cjs',
  cli: 'clients/build/coral-cli.cjs',
  claudeAppserver: 'clients/build/coral-claude-appserver.cjs',
  manifest: 'clients/build/manifest.json',
} as const;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeFixtureFile(root: string, path: string, content: string): void {
  mkdirSync(resolve(root, path, '..'), { recursive: true });
  writeFileSync(resolve(root, path), content);
}

function createFreshBuildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-bundle-freshness-'));
  for (const input of INPUTS) {
    writeFixtureFile(root, input, `input:${input}`);
  }
  for (const path of Object.values(OUTPUTS)) {
    writeFixtureFile(root, path, `output:${path}`);
  }

  const receipt: BundleFreshnessReceiptV1 = {
    schemaVersion: 1,
    algorithm: 'sha256',
    flavor: 'dev',
    sourceSha256: lifecycleBundleSourceSha256(root, INPUTS),
    inputs: [...INPUTS],
    outputs: {
      backend: { path: OUTPUTS.backend, sha256: sha256(`output:${OUTPUTS.backend}`) },
      cli: { path: OUTPUTS.cli, sha256: sha256(`output:${OUTPUTS.cli}`) },
      claudeAppserver: {
        path: OUTPUTS.claudeAppserver,
        sha256: sha256(`output:${OUTPUTS.claudeAppserver}`),
      },
      manifest: { path: OUTPUTS.manifest, sha256: sha256(`output:${OUTPUTS.manifest}`) },
    },
  };
  writeFixtureFile(root, 'clients/build/build-receipt.json', JSON.stringify(receipt));
  return root;
}

function captureFreshnessResult(root: string): string {
  try {
    assertLifecycleBundleSetFresh(root);
    return 'accepted';
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('lifecycle bundle build freshness', () => {
  it('accepts a valid four-output receipt', () => {
    const root = createFreshBuildFixture();

    expect(() => assertLifecycleBundleSetFresh(root)).not.toThrow();
  });

  it('rejects stale lifecycle build inputs and outputs', () => {
    const root = createFreshBuildFixture();
    const changedInput = INPUTS[3];

    writeFixtureFile(root, changedInput, 'changed input bytes');
    const sourceResult = captureFreshnessResult(root);
    writeFixtureFile(root, changedInput, `input:${changedInput}`);

    writeFixtureFile(root, OUTPUTS.backend, 'changed backend bytes');
    const outputResult = captureFreshnessResult(root);
    writeFixtureFile(root, OUTPUTS.backend, `output:${OUTPUTS.backend}`);

    writeFixtureFile(root, 'clients/build/build-receipt.json', '{');
    const malformedResult = captureFreshnessResult(root);

    expect({ sourceResult, outputResult, malformedResult }).toEqual({
      sourceResult: STALE_BUILD_DIAGNOSTIC,
      outputResult: STALE_BUILD_DIAGNOSTIC,
      malformedResult: STALE_BUILD_DIAGNOSTIC,
    });
  });

  it('rejects a manifest-only lifecycle build mutation', () => {
    const root = createFreshBuildFixture();

    writeFixtureFile(root, OUTPUTS.manifest, 'changed manifest bytes');

    expect(captureFreshnessResult(root)).toBe(STALE_BUILD_DIAGNOSTIC);
  });
});
