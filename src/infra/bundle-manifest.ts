import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import type { BuildFlavor } from './build-flavor.js';
import { isRecord } from './json.js';
import type { StorageBigIntStat } from './port-types.js';

declare const __BUNDLE_DIR__: string | undefined;
declare const __VERSION__: string | undefined;
declare const __BUILD_SET_ID__: string | undefined;
declare const __BUILD_FLAVOR__: string | undefined;
declare const __STORE_FORMAT_FINGERPRINT__: string | undefined;

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
  readonly storeFormatFingerprint: string;
};

export type StrictBundleManifest = EmbeddedBundleIdentity & {
  readonly bundleHash: string;
  readonly cliBundleHash: string;
  readonly claudeAppserverBundleHash: string;
};

const embeddedBundleIdentitySchema = z
  .object({
    version: z.string().max(128).regex(VERSION_PATTERN),
    buildSetId: z.string().regex(BUILD_SET_ID_PATTERN),
    flavor: z.enum(['dev', 'prod']),
    storeFormatFingerprint: z.string().regex(STORE_FORMAT_FINGERPRINT_PATTERN),
  })
  .strict();

export const strictBundleManifestSchema = embeddedBundleIdentitySchema
  .extend({
    bundleHash: z.string().regex(BUNDLE_HASH_PATTERN),
    cliBundleHash: z.string().regex(BUNDLE_HASH_PATTERN),
    claudeAppserverBundleHash: z.string().regex(BUNDLE_HASH_PATTERN),
  })
  .strict();

export type StrictBundleIdentityFailure =
  | 'embedded_identity_unavailable'
  | 'adjacent_manifest_unavailable'
  | 'adjacent_manifest_invalid'
  | 'adjacent_manifest_mismatch';

export type StrictBundleIdentityResult =
  | { readonly ok: true; readonly manifest: StrictBundleManifest }
  | { readonly ok: false; readonly reason: StrictBundleIdentityFailure };

export type BoundedAdjacentManifestResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'unavailable' | 'invalid' };

function bundleDir(): string | null {
  return typeof __BUNDLE_DIR__ === 'string' && __BUNDLE_DIR__.length > 0 ? __BUNDLE_DIR__ : null;
}

export function resolveRunningBundleDir(pluginRoot: string): string | null {
  const candidate = resolve(bundleDir() ?? join(pluginRoot, 'bridge'));
  try {
    const canonical = realpathSync(candidate);
    const stat = lstatSync(canonical);
    return stat.isDirectory() && !stat.isSymbolicLink() ? canonical : null;
  } catch {
    return null;
  }
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
    (__BUILD_FLAVOR__ !== 'dev' && __BUILD_FLAVOR__ !== 'prod') ||
    typeof __STORE_FORMAT_FINGERPRINT__ !== 'string'
  ) {
    return null;
  }
  return {
    version: __VERSION__,
    buildSetId: __BUILD_SET_ID__,
    flavor: __BUILD_FLAVOR__,
    storeFormatFingerprint: __STORE_FORMAT_FINGERPRINT__,
  };
}

/**
 * The storage surface `readBoundedFileAtIdentity` needs to re-verify a file's identity across an open and a
 * full read: a subset any `StoragePort`-shaped caller already has (`Pick<StoragePort, ...>` satisfies this
 * structurally), plus the raw-`node:fs` bindings this module itself uses before any runtime is composed.
 */
export type BoundedFileReadStorage = Readonly<{
  lstatSync(path: string): { isFile(): boolean; isSymbolicLink(): boolean };
  statSync(path: string, options: { bigint: true }): StorageBigIntStat;
  openSync(path: string, flags: string): number;
  fstatSync(fd: number, options: { bigint: true }): StorageBigIntStat;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
}>;

const nodeFsBoundedReadStorage: BoundedFileReadStorage = {
  lstatSync,
  statSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
};

/**
 * True when two stats describe the same on-disk file at the same instant: device + inode (so a rename-and-
 * replace under the same name is refused), mode + owning uid (so an in-place chmod/chown between checkpoints
 * is refused), and size + mtime (so an in-place rewrite is refused even when neither identity field moved).
 */
export function sameFileIdentity(left: StorageBigIntStat, right: StorageBigIntStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

/**
 * Reads a regular file already verified at `baseline` — the caller's own pre-open stat, carrying whatever
 * ownership or path policy it enforced there — re-verifying that identity twice more: once against the
 * freshly opened descriptor, and once more, against both the descriptor and the path, after the full bounded
 * read completes. Those are the two checkpoints a bare size comparison skips past: a swap between the
 * baseline stat and `open`, and a rewrite while the read was still in flight. Returns `null` for any
 * mismatch, oversize, or non-regular-file condition — a caller distinguishes "changed under us" from a
 * genuine decode failure on its own terms.
 */
export function readBoundedFileAtIdentity(
  storage: BoundedFileReadStorage,
  path: string,
  baseline: StorageBigIntStat,
  maxBytes: number,
): Buffer | null {
  if (!baseline.isFile() || baseline.size < 0n || baseline.size > BigInt(maxBytes)) {
    return null;
  }
  let descriptor: number | null = null;
  try {
    descriptor = storage.openSync(path, 'r');
    const opened = storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(baseline, opened)) {
      return null;
    }

    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = storage.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maxBytes) {
      return null;
    }

    const openedAfter = storage.fstatSync(descriptor, { bigint: true });
    const linkAfter = storage.lstatSync(path);
    const pathAfter = storage.statSync(path, { bigint: true });
    if (
      !sameFileIdentity(opened, openedAfter) ||
      !linkAfter.isFile() ||
      linkAfter.isSymbolicLink() ||
      !sameFileIdentity(opened, pathAfter)
    ) {
      return null;
    }

    return bytes.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        storage.closeSync(descriptor);
      } catch {
        // Best effort: the read result above already determined success or failure.
      }
    }
  }
}

export function readBoundedAdjacentManifest(activeBundleDir: string): BoundedAdjacentManifestResult {
  const path = join(activeBundleDir, 'manifest.json');
  let baseline: BigIntStats;
  try {
    baseline = lstatSync(path, { bigint: true });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!baseline.isFile() || baseline.isSymbolicLink()) {
    return { ok: false, reason: 'unavailable' };
  }
  const bytes = readBoundedFileAtIdentity(nodeFsBoundedReadStorage, path, baseline, MAX_STRICT_BUNDLE_MANIFEST_BYTES);
  if (bytes === null) {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function parseStrictManifest(value: unknown): StrictBundleManifest | null {
  const parsed = strictBundleManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function hashStableAdjacentBundle(activeBundleDir: string, fileName: string): string | null {
  const path = join(activeBundleDir, fileName);
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

/**
 * Validate the executing three-artifact bundle set against its adjacent
 * manifest, including embedded identity and stable content hashes.
 */
export function resolveStrictBundleIdentity(options?: {
  readonly bundleDir?: string;
  readonly embedded?: EmbeddedBundleIdentity;
}): StrictBundleIdentityResult {
  const embedded = options?.embedded ?? embeddedBundleIdentity();
  if (embedded === null || !embeddedBundleIdentitySchema.safeParse(embedded).success) {
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
    manifest.storeFormatFingerprint !== embedded.storeFormatFingerprint ||
    hashStableAdjacentBundle(activeBundleDir, 'coral-backend.cjs') !== manifest.bundleHash ||
    hashStableAdjacentBundle(activeBundleDir, 'coral-cli.cjs') !== manifest.cliBundleHash ||
    hashStableAdjacentBundle(activeBundleDir, 'coral-claude-appserver.cjs') !== manifest.claudeAppserverBundleHash
  ) {
    return { ok: false, reason: 'adjacent_manifest_mismatch' };
  }
  return { ok: true, manifest };
}
