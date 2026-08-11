import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs';

import type { StorageBigIntStat } from './port-types.js';

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

/** The raw `node:fs` bindings, satisfying `BoundedFileReadStorage` for a caller with no `StoragePort` of its
 *  own yet — `bundle-manifest.ts`'s own pre-runtime adjacent-manifest read being exactly that caller. */
export const nodeFsBoundedReadStorage: BoundedFileReadStorage = {
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
      !sameFileIdentity(opened, pathAfter) ||
      // A `readSync` that stops early with `read === 0` before the descriptor's own size is reached is a
      // short read, not EOF — the loop above has no way to tell the two apart on its own, so it is caught
      // here by holding the bytes actually collected to the size this same descriptor just reported.
      // Without it, a short read looks identical to the identity checks above (nothing on disk moved) and
      // returns a silently truncated buffer instead of refusing it.
      openedAfter.size !== BigInt(offset)
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
