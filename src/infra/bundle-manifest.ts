import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import { isRecord } from './json.js';

declare const __BUNDLE_DIR__: string | undefined;
declare const __VERSION__: string | undefined;
declare const __BUILD_SET_ID__: string | undefined;
declare const __BUILD_FLAVOR__: string | undefined;

const MAX_STRICT_BUNDLE_MANIFEST_BYTES = 16 * 1024;
const MAX_STRICT_BACKEND_BUNDLE_BYTES = 256 * 1024 * 1024;
const BUILD_SET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUNDLE_HASH_PATTERN = /^[0-9a-f]{16}$/;
const STORE_FORMAT_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type EmbeddedBundleIdentity = {
  readonly version: string;
  readonly buildSetId: string;
  readonly flavor: BuildFlavor;
};

export type StrictBundleManifest = EmbeddedBundleIdentity & {
  readonly bundleHash: string;
  readonly storeFormatFingerprint: string;
};

export type StrictBundleIdentityFailure =
  | 'embedded_identity_unavailable'
  | 'adjacent_manifest_unavailable'
  | 'adjacent_manifest_invalid'
  | 'adjacent_manifest_mismatch';

export type StrictBundleIdentityResult =
  | { readonly ok: true; readonly manifest: StrictBundleManifest }
  | { readonly ok: false; readonly reason: StrictBundleIdentityFailure };

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

function embeddedBundleIdentity(): EmbeddedBundleIdentity | null {
  if (
    typeof __VERSION__ !== 'string' ||
    typeof __BUILD_SET_ID__ !== 'string' ||
    (__BUILD_FLAVOR__ !== 'dev' && __BUILD_FLAVOR__ !== 'prod')
  ) {
    return null;
  }
  return {
    version: __VERSION__,
    buildSetId: __BUILD_SET_ID__,
    flavor: __BUILD_FLAVOR__,
  };
}

function readBoundedAdjacentManifest(
  activeBundleDir: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: 'unavailable' | 'invalid' } {
  let descriptor: number | null = null;
  let contents: Uint8Array;
  let closeFailed = false;
  try {
    descriptor = openSync(join(activeBundleDir, 'manifest.json'), 'r');
    const initialSize = fstatSync(descriptor).size;
    if (!Number.isSafeInteger(initialSize) || initialSize < 0 || initialSize > MAX_STRICT_BUNDLE_MANIFEST_BYTES) {
      return { ok: false, reason: 'unavailable' };
    }

    const bytes = Buffer.allocUnsafe(MAX_STRICT_BUNDLE_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) {
        break;
      }
      offset += read;
    }
    if (offset > MAX_STRICT_BUNDLE_MANIFEST_BYTES) {
      return { ok: false, reason: 'unavailable' };
    }
    contents = bytes.subarray(0, offset);
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        closeFailed = true;
      }
    }
  }

  if (closeFailed) {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function parseStrictManifest(value: unknown): StrictBundleManifest | null {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    value.version.length > 128 ||
    !VERSION_PATTERN.test(value.version) ||
    typeof value.buildSetId !== 'string' ||
    !BUILD_SET_ID_PATTERN.test(value.buildSetId) ||
    typeof value.bundleHash !== 'string' ||
    !BUNDLE_HASH_PATTERN.test(value.bundleHash) ||
    (value.flavor !== 'dev' && value.flavor !== 'prod') ||
    typeof value.storeFormatFingerprint !== 'string' ||
    !STORE_FORMAT_FINGERPRINT_PATTERN.test(value.storeFormatFingerprint)
  ) {
    return null;
  }
  return {
    version: value.version,
    buildSetId: value.buildSetId,
    bundleHash: value.bundleHash,
    flavor: value.flavor,
    storeFormatFingerprint: value.storeFormatFingerprint,
  };
}

function hashStableAdjacentBackend(activeBundleDir: string): string | null {
  const path = join(activeBundleDir, 'coral-backend.cjs');
  let descriptor: number | null = null;
  let digest: string | undefined;
  let closeFailed = false;
  try {
    const pathBefore = lstatSync(path, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return null;
    descriptor = openSync(path, 'r');
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(MAX_STRICT_BACKEND_BUNDLE_BYTES) ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino
    ) {
      return null;
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0n;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += BigInt(bytesRead);
      if (total > before.size) return null;
      hash.update(buffer.subarray(0, bytesRead));
    }

    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      total !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size ||
      pathAfter.mtimeNs !== before.mtimeNs
    ) {
      return null;
    }
    digest = hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        closeFailed = true;
      }
    }
  }
  return closeFailed ? null : (digest ?? null);
}

export function resolveStrictBundleIdentity(options?: {
  readonly bundleDir?: string;
  readonly embedded?: EmbeddedBundleIdentity;
}): StrictBundleIdentityResult {
  const embedded = options?.embedded ?? embeddedBundleIdentity();
  if (
    embedded === null ||
    embedded.version.length === 0 ||
    embedded.version.length > 128 ||
    !VERSION_PATTERN.test(embedded.version) ||
    !BUILD_SET_ID_PATTERN.test(embedded.buildSetId) ||
    (embedded.flavor !== 'dev' && embedded.flavor !== 'prod')
  ) {
    return { ok: false, reason: 'embedded_identity_unavailable' };
  }

  const activeBundleDir = options?.bundleDir ?? bundleDir();
  if (activeBundleDir === null) {
    return { ok: false, reason: 'adjacent_manifest_unavailable' };
  }
  const adjacent = readBoundedAdjacentManifest(activeBundleDir);
  if (!adjacent.ok && adjacent.reason === 'unavailable') {
    return { ok: false, reason: 'adjacent_manifest_unavailable' };
  }
  if (!adjacent.ok) {
    return { ok: false, reason: 'adjacent_manifest_invalid' };
  }
  const manifest = parseStrictManifest(adjacent.value);
  if (manifest === null) {
    return { ok: false, reason: 'adjacent_manifest_invalid' };
  }
  if (
    manifest.version !== embedded.version ||
    manifest.buildSetId !== embedded.buildSetId ||
    manifest.flavor !== embedded.flavor ||
    hashStableAdjacentBackend(activeBundleDir) !== manifest.bundleHash
  ) {
    return { ok: false, reason: 'adjacent_manifest_mismatch' };
  }
  return { ok: true, manifest };
}
