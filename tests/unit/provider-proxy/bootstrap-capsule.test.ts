import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleIdentityResult } from '#src/infra/bundle-manifest.js';
import {
  consumeProviderBootstrapCapsule,
  createProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES,
  type ProviderBootstrapCapsuleEnvironment,
  ProviderBootstrapCapsuleError,
  type ProxyBootstrapCapsule,
  type ReaperBootstrapCapsule,
} from '#src/provider-proxy/bootstrap-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';

const GUARDIAN_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const REAPER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const PROXY_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const BUILD_SET_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_BUILD_SET_ID = '55555555-5555-4555-8555-555555555555';
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
    },
  };
}

function expectCapsuleFailure(run: () => unknown, code: ProviderBootstrapCapsuleError['code']): void {
  let observed: unknown;
  try {
    run();
  } catch (error: unknown) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(ProviderBootstrapCapsuleError);
  expect(observed).toMatchObject({ code });
}

function writeRawCapsule(value: unknown): void {
  env.storage.writeFileSync(capsulePath, typeof value === 'string' ? value : JSON.stringify(value), {
    encoding: 'utf8',
    mode: 0o600,
  });
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
  it('creates canonical current-uid mode-0600 data and consumes it once', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);

    const stat = statSync(capsulePath, { bigint: true });
    const encoded = readFileSync(capsulePath, 'utf8');
    expect(stat.uid).toBe(BigInt(env.uid));
    expect(stat.mode & 0o777n).toBe(0o600n);
    expect(encoded).toBe(JSON.stringify(JSON.parse(encoded)));
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES);

    expect(consumeProviderBootstrapCapsule(capsulePath, 'guardian', env)).toEqual(capsule);
    expect(existsSync(capsulePath)).toBe(false);
    expect(existsSync(`${capsulePath}.consuming`)).toBe(false);
  });

  it('round-trips the strict reaper and proxy role field sets', () => {
    const reaperPath = join(tempRoot, 'reaper.bootstrap.json');
    const reaper: ReaperBootstrapCapsule = {
      role: 'reaper',
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      guardianInstanceId: capsule.guardianInstanceId,
      reaperInstanceId: capsule.reaperInstanceId,
      proxyInstanceId: capsule.proxyInstanceId,
      bootstrapNonce: 'f'.repeat(64),
      canonicalControlEndpoint: capsule.reaperControlEndpoint,
      guardianControlEndpoint: capsule.canonicalControlEndpoint,
      proxyEndpoint: capsule.proxyEndpoint,
      guardianReaperAuthSecret: capsule.guardianReaperAuthSecret,
    };
    const proxyPath = join(tempRoot, 'proxy.bootstrap.json');
    const proxy: ProxyBootstrapCapsule = {
      role: 'proxy',
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      guardianInstanceId: capsule.guardianInstanceId,
      reaperInstanceId: capsule.reaperInstanceId,
      proxyInstanceId: capsule.proxyInstanceId,
      bootstrapNonce: '0'.repeat(64),
      canonicalEndpoint: capsule.proxyEndpoint,
      guardianControlEndpoint: capsule.canonicalControlEndpoint,
      proxyGuardianAuthSecret: capsule.proxyGuardianAuthSecret,
    };

    createProviderBootstrapCapsule(reaperPath, reaper, env);
    createProviderBootstrapCapsule(proxyPath, proxy, env);

    expect(consumeProviderBootstrapCapsule(reaperPath, 'reaper', env)).toEqual(reaper);
    expect(consumeProviderBootstrapCapsule(proxyPath, 'proxy', env)).toEqual(proxy);
  });

  it('rejects unknown capsule fields through the strict role schema', () => {
    writeRawCapsule({ ...capsule, unexpected: true });

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', env),
      'bootstrap_capsule_invalid',
    );
  });

  it('rejects a capsule whose mode is not 0600', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);
    chmodSync(capsulePath, 0o644);

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', env),
      'bootstrap_capsule_not_private',
    );
  });

  it('rejects a capsule whose filesystem owner is not the consuming uid', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', { ...env, uid: env.uid + 1 }),
      'bootstrap_capsule_not_private',
    );
  });

  it('rejects replay after the first consumption removed the consumable name', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);
    consumeProviderBootstrapCapsule(capsulePath, 'guardian', env);

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', env),
      'bootstrap_capsule_replayed',
    );
  });

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

  it('rejects a capsule from a different build set', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);

    expectCapsuleFailure(
      () =>
        consumeProviderBootstrapCapsule(capsulePath, 'guardian', {
          ...env,
          resolveStrictIdentity: () => strictIdentity(OTHER_BUILD_SET_ID),
        }),
      'bootstrap_capsule_build_set_mismatch',
    );
  });

  it.each([
    ['relative', 'relative/guardian.bootstrap.json'],
    ['unnormalized', () => `${tempRoot}/nested/../guardian.bootstrap.json`],
  ])('rejects a %s capsule path before filesystem access', (_name, value) => {
    const path = typeof value === 'function' ? value() : value;
    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(path, 'guardian', env),
      'bootstrap_capsule_non_canonical_path',
    );
  });

  it('rejects a symlink where a regular capsule file is required', () => {
    const target = join(tempRoot, 'target.bootstrap.json');
    env.storage.writeFileSync(target, JSON.stringify(capsule), { encoding: 'utf8', mode: 0o600 });
    symlinkSync(target, capsulePath);

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', env),
      'bootstrap_capsule_non_canonical_path',
    );
  });

  it('rejects an envelope over the 4096-byte pre-parse budget', () => {
    writeRawCapsule('x'.repeat(MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES + 1));

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', env),
      'bootstrap_capsule_too_large',
    );
  });

  it('rejects an overlength scalar before resolving build authority', () => {
    const resolveStrictIdentity = vi.fn(() => strictIdentity());
    writeRawCapsule({ ...capsule, buildSetId: `${BUILD_SET_ID}0` });

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', { ...env, resolveStrictIdentity }),
      'bootstrap_capsule_scalar_too_long',
    );
    expect(resolveStrictIdentity).not.toHaveBeenCalled();
  });

  // `readClaimedCapsule` reads through `readBoundedFileAtIdentity`, the same shared primitive
  // `handoff-capsule.ts` reads through — these two mirror that file's own same-length-twin/symlink-mid-read
  // tests.
  it('refuses a capsule swapped for a same-length twin between the claim and the open', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);
    const claimedPath = `${capsulePath}${'.consuming'}`;
    const twin: GuardianBootstrapCapsule = { ...capsule, bootstrapNonce: 'f'.repeat(64) };
    expect(JSON.stringify(capsule).length).toBe(JSON.stringify(twin).length);
    const swapPath = join(tempRoot, 'twin.json');

    const swappingStorage: ProviderBootstrapCapsuleEnvironment['storage'] = {
      ...env.storage,
      openSync: (path, flags) => {
        env.storage.writeFileSync(swapPath, JSON.stringify(twin), { encoding: 'utf8', mode: 0o600 });
        env.storage.renameSync(swapPath, claimedPath);
        return env.storage.openSync(path, flags);
      },
    };

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', { ...env, storage: swappingStorage }),
      'bootstrap_capsule_unreadable',
    );
  });

  it('refuses a capsule swapped for a symlink while the read was still in flight', () => {
    createProviderBootstrapCapsule(capsulePath, capsule, env);
    const claimedPath = `${capsulePath}${'.consuming'}`;
    const targetPath = join(tempRoot, 'elsewhere.json');

    let readCount = 0;
    const swappingStorage: ProviderBootstrapCapsuleEnvironment['storage'] = {
      ...env.storage,
      readSync: (fd, buffer, offset, length, position) => {
        const read = env.storage.readSync(fd, buffer, offset, length, position);
        readCount += 1;
        if (readCount === 1) {
          writeFileSync(targetPath, JSON.stringify(capsule), { encoding: 'utf-8', mode: 0o600 });
          unlinkSync(claimedPath);
          symlinkSync(targetPath, claimedPath);
        }
        return read;
      },
    };

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', { ...env, storage: swappingStorage }),
      'bootstrap_capsule_unreadable',
    );
  });

  it('rejects a non-canonical embedded endpoint before resolving build authority', () => {
    const resolveStrictIdentity = vi.fn(() => strictIdentity());
    writeRawCapsule({ ...capsule, canonicalControlEndpoint: 'relative/guardian.sock' });

    expectCapsuleFailure(
      () => consumeProviderBootstrapCapsule(capsulePath, 'guardian', { ...env, resolveStrictIdentity }),
      'bootstrap_capsule_non_canonical_path',
    );
    expect(resolveStrictIdentity).not.toHaveBeenCalled();
  });
});
