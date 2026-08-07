import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readBoundedFileAtIdentity,
  resolveRunningBundleDir,
  resolveStrictBundleIdentity,
  sameFileIdentity,
  type BoundedFileReadStorage,
  type EmbeddedBundleIdentity,
  type StrictBundleManifest,
} from '#src/infra/bundle-manifest.js';
import type { StorageBigIntStat } from '#src/infra/port-types.js';

const roots: string[] = [];
const embedded: EmbeddedBundleIdentity = {
  version: '0.9.16',
  buildSetId: '123e4567-e89b-12d3-a456-426614174000',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};
const backendBundle = 'strict backend fixture';
const cliBundle = 'strict cli fixture';
const claudeAppserverBundle = 'strict claude appserver fixture';
const manifest: StrictBundleManifest = {
  ...embedded,
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
};

function bundleDir(contents: unknown = manifest): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-strict-bundle-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'coral-backend.cjs'), backendBundle, 'utf-8');
  writeFileSync(join(root, 'coral-cli.cjs'), cliBundle, 'utf-8');
  writeFileSync(join(root, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf-8');
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(contents)}\n`, 'utf-8');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundle-manifest', () => {
  it('accepts only an adjacent manifest matching the embedded build identity', () => {
    expect(resolveStrictBundleIdentity({ bundleDir: bundleDir(), embedded })).toEqual({
      ok: true,
      manifest,
    });
  });

  it.each([
    ['version', { ...manifest, version: '0.9.15' }],
    ['build set', { ...manifest, buildSetId: '223e4567-e89b-12d3-a456-426614174000' }],
    ['flavor', { ...manifest, flavor: 'dev' }],
    ['store format', { ...manifest, storeFormatFingerprint: `sha256:${'b'.repeat(64)}` }],
  ])('rejects a stale %s pairing', (_name, stale) => {
    expect(resolveStrictBundleIdentity({ bundleDir: bundleDir(stale), embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_mismatch',
    });
  });

  it('rejects a missing adjacent manifest without searching another directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-strict-bundle-missing-'));
    roots.push(root);
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_unavailable',
    });
  });

  it('rejects an adjacent backend whose content does not match the manifest', () => {
    const root = bundleDir();
    writeFileSync(join(root, 'coral-backend.cjs'), 'tampered backend', 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_mismatch',
    });
  });

  it.each([
    ['coral-cli.cjs', 'tampered cli'],
    ['coral-claude-appserver.cjs', 'tampered claude appserver'],
  ])('rejects a mismatched adjacent %s artifact', (file, contents) => {
    const root = bundleDir();
    writeFileSync(join(root, file), contents, 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_mismatch',
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['invalid version', JSON.stringify({ ...manifest, version: 'latest' })],
    ['invalid build-set ID', JSON.stringify({ ...manifest, buildSetId: 'not-a-uuid' })],
    ['invalid bundle hash', JSON.stringify({ ...manifest, bundleHash: 'bundle' })],
    ['invalid fingerprint', JSON.stringify({ ...manifest, storeFormatFingerprint: 'old' })],
    ['unknown manifest field', JSON.stringify({ ...manifest, extra: true })],
  ])('rejects %s', (_name, contents) => {
    const root = bundleDir();
    writeFileSync(join(root, 'manifest.json'), contents, 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_invalid',
    });
  });

  it('bounds the adjacent manifest before parsing', () => {
    const root = bundleDir();
    writeFileSync(join(root, 'manifest.json'), 'x'.repeat(16 * 1024 + 1), 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_unavailable',
    });
  });

  it('rejects a symlinked adjacent manifest', () => {
    const root = bundleDir();
    const target = join(root, 'manifest-target.json');
    writeFileSync(target, `${JSON.stringify(manifest)}\n`, 'utf-8');
    rmSync(join(root, 'manifest.json'));
    symlinkSync(target, join(root, 'manifest.json'));

    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_unavailable',
    });
  });

  it('resolves the running bridge directory to a canonical path', () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-running-bundle-'));
    roots.push(pluginRoot);
    const bridge = join(pluginRoot, 'bridge');
    mkdirSync(bridge);

    expect(resolveRunningBundleDir(pluginRoot)).toBe(realpathSync(bridge));
  });
});

function fakeStat(overrides: Partial<StorageBigIntStat> = {}): StorageBigIntStat {
  return {
    dev: 1n,
    ino: 2n,
    mode: 0o100600n,
    uid: 1000n,
    size: 4n,
    mtimeNs: 100n,
    isDirectory: () => false,
    isFile: () => true,
    ...overrides,
  };
}

describe('sameFileIdentity', () => {
  it('is true only when device, inode, mode, uid, size, and mtime all agree', () => {
    expect(sameFileIdentity(fakeStat(), fakeStat())).toBe(true);
    expect(sameFileIdentity(fakeStat(), fakeStat({ dev: 2n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ ino: 3n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ mode: 0o100644n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ uid: 1001n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ size: 5n }))).toBe(false);
    expect(sameFileIdentity(fakeStat(), fakeStat({ mtimeNs: 101n }))).toBe(false);
  });
});

describe('readBoundedFileAtIdentity', () => {
  const content = Buffer.from('true');

  function readingStorage(overrides: Partial<BoundedFileReadStorage> = {}): BoundedFileReadStorage {
    return {
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      statSync: () => fakeStat(),
      openSync: () => 7,
      fstatSync: () => fakeStat(),
      readSync: (_fd, buffer, offset) => {
        if (offset !== 0) return 0;
        content.copy(buffer, 0);
        return content.length;
      },
      closeSync: () => {},
      ...overrides,
    };
  }

  it('reads bytes matching the baseline identity, then closes the descriptor', () => {
    let closed = false;
    const storage = readingStorage({ closeSync: () => (closed = true) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)?.toString('utf-8')).toBe('true');
    expect(closed).toBe(true);
  });

  it('refuses a baseline already over the byte cap without opening the file', () => {
    let opened = false;
    const storage = readingStorage({ openSync: () => ((opened = true), 7) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat({ size: 100n }), 4)).toBeNull();
    expect(opened).toBe(false);
  });

  it('refuses a file whose identity had already moved by the time it was opened', () => {
    const storage = readingStorage({ fstatSync: () => fakeStat({ ino: 999n }) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a file whose owner changed while the read was in flight', () => {
    let fstatCalls = 0;
    const storage = readingStorage({
      fstatSync: () => {
        fstatCalls += 1;
        return fstatCalls === 1 ? fakeStat() : fakeStat({ uid: 999n });
      },
    });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a path replaced by a symlink while the read was in flight', () => {
    const storage = readingStorage({ lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a path whose full stat moved while the read was in flight', () => {
    const storage = readingStorage({ statSync: () => fakeStat({ size: 999n }) });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
  });

  it('refuses a read that produced more bytes than the baseline promised', () => {
    const storage = readingStorage({
      fstatSync: () => fakeStat({ size: 2n }),
      readSync: (_fd, buffer, offset) => {
        buffer.fill(1, offset, offset + 1);
        return 1;
      },
    });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat({ size: 2n }), 2)).toBeNull();
  });

  it('closes the descriptor even when the read throws', () => {
    let closed = false;
    const storage = readingStorage({
      readSync: () => {
        throw new Error('boom');
      },
      closeSync: () => (closed = true),
    });

    expect(readBoundedFileAtIdentity(storage, '/x', fakeStat(), 64)).toBeNull();
    expect(closed).toBe(true);
  });
});
