import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StrictBundleIdentityResult } from '#src/infra/bundle-manifest.js';
import {
  consumeProviderBootstrapCapsule,
  createProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProviderBootstrapCapsuleEnvironment,
  ProviderBootstrapCapsuleError,
} from '#src/provider-proxy/bootstrap-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';

const GUARDIAN_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const REAPER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const PROXY_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const BUILD_SET_ID = '44444444-4444-4444-8444-444444444444';
const HOST_FINGERPRINT = 'a'.repeat(64);
const BOOTSTRAP_NONCE = 'b'.repeat(64);
const GUARDIAN_REAPER_SECRET = 'c'.repeat(64);
const PROXY_GUARDIAN_SECRET = 'd'.repeat(64);

let tempRoot: string;
let capsulePath: string;
let capsule: GuardianBootstrapCapsule;
let env: ProviderBootstrapCapsuleEnvironment;

function strictIdentity(
  buildSetId: string = BUILD_SET_ID,
  flavor: 'dev' | 'prod' = 'prod',
): StrictBundleIdentityResult {
  return {
    ok: true,
    manifest: {
      version: '1.0.0',
      buildSetId,
      flavor,
      storeFormatFingerprint: `sha256:${'e'.repeat(64)}`,
      bundleHash: '1'.repeat(16),
      cliBundleHash: '2'.repeat(16),
      claudeAppserverBundleHash: '3'.repeat(16),
      durableWrapperBundleHash: '4'.repeat(16),
    },
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coral-provider-bootstrap-capsule-'));
  capsulePath = join(tempRoot, 'guardian.bootstrap.json');
  const storage = createRealRuntime('dev', { baseDir: tempRoot }).storage;
  const uid = Number(statSync(tempRoot, { bigint: true }).uid);
  capsule = {
    role: 'guardian',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: BUILD_SET_ID,
    hostFingerprint: HOST_FINGERPRINT,
    guardianInstanceId: GUARDIAN_INSTANCE_ID,
    reaperInstanceId: REAPER_INSTANCE_ID,
    proxyInstanceId: PROXY_INSTANCE_ID,
    bootstrapNonce: BOOTSTRAP_NONCE,
    canonicalControlEndpoint: join(tempRoot, 'guardian.sock'),
    reaperControlEndpoint: join(tempRoot, 'reaper.sock'),
    proxyEndpoint: join(tempRoot, 'proxy.sock'),
    guardianReaperAuthSecret: GUARDIAN_REAPER_SECRET,
    proxyGuardianAuthSecret: PROXY_GUARDIAN_SECRET,
  };
  env = { storage, uid, resolveStrictIdentity: () => strictIdentity() };
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('provider bootstrap capsules', () => {
  it('atomically excludes a second consumer interleaved immediately after the claim', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);
    let secondFailure: unknown;
    const interleavingStorage: ProviderBootstrapCapsuleEnvironment['storage'] = {
      ...env.storage,
      renameSync: (oldPath, newPath) => {
        env.storage.renameSync(oldPath, newPath);
        try {
          consumeProviderBootstrapCapsule(capsulePath, 'guardian', env);
        } catch (error: unknown) {
          secondFailure = error;
        }
      },
    };

    expect(consumeProviderBootstrapCapsule(capsulePath, 'guardian', { ...env, storage: interleavingStorage })).toEqual(
      capsule,
    );
    expect(secondFailure).toBeInstanceOf(ProviderBootstrapCapsuleError);
    expect(secondFailure).toMatchObject({ code: 'bootstrap_capsule_replayed' });
  });
});
