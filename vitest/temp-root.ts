import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `statfs.f_type` for tmpfs, from `linux/magic.h`. */
const TMPFS_MAGIC = 0x01021994;

/** A full `test:e2e:*` run copies bundle sets per fixture; measured peak for the whole suite is under 64 MiB,
 *  and this floor leaves room for several concurrent runs before a fallback is preferable to a full device. */
const REQUIRED_FREE_BYTES = 1024 * 1024 * 1024;

const DEFAULT_CANDIDATES: ReadonlyArray<string | undefined> = ['/dev/shm', process.env.XDG_RUNTIME_DIR];

function tmpfsWithRoom(candidate: string): boolean {
  try {
    const stats = statfsSync(candidate);
    return stats.type === TMPFS_MAGIC && stats.bavail * stats.bsize >= REQUIRED_FREE_BYTES;
  } catch {
    return false;
  }
}

/** Every unix socket the suites bind sits under this root, and `AF_UNIX` truncates `sun_path` at a fixed
 *  small limit — 108 bytes on Linux — so bytes spent on the name are bytes the rest of the path cannot use.
 *  `tests/invariants/temp-root-socket-budget.test.ts` holds the arithmetic. */
export function userRootName(): string {
  const identity = process.getuid?.() ?? process.env.USERNAME ?? process.env.USER ?? 'unknown';
  return `coral-${String(identity).replaceAll(/[^a-zA-Z0-9_-]/gu, '_')}`;
}

function executableRoot(root: string): boolean {
  if (process.platform === 'win32') return true;
  let probeDirectory: string | null = null;
  try {
    probeDirectory = mkdtempSync(join(root, '.exec-probe-'));
    const probe = join(probeDirectory, 'probe');
    writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(probe, 0o700);
    const result = spawnSync(probe, [], { stdio: 'ignore', timeout: 1_000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  } finally {
    if (probeDirectory !== null) rmSync(probeDirectory, { recursive: true, force: true });
  }
}

function secureUserRoot(base: string): string | null {
  const root = join(base, userRootName());
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stats = lstatSync(root);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o777) !== 0o700) {
      return null;
    }
    return executableRoot(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * Where tests put the directories they create with `mkdtempSync(join(tmpdir(), …))`.
 *
 * A memory-backed filesystem makes `fsync` a no-op, and the suite's cost is dominated by it: every test that
 * opens SQLite or writes atomically pays one device round trip per durability point. Measured on a WSL2 VHDX
 * whose fsync had degraded to 300 ms, the three store suites took 228 s and timed out ten cases on the disk
 * and 2.5 s with none on tmpfs.
 *
 * Durability is the only property given up, and no test can assert it: rename atomicity and write ordering —
 * what the crash-cut and atomic-publication suites actually exercise — hold on tmpfs exactly as on disk.
 *
 * Falls back to the platform temp directory whenever a memory-backed root is absent, too small, unsafe, or
 * mounted `noexec`. `CORAL_TEST_TMPDIR` overrides candidate selection but must pass the same root checks.
 * `candidates` and its classifier are parameters so the fallback remains reachable without assuming what
 * filesystem the checkout or platform temp directory uses.
 */
export function testTempRoot(
  candidates: ReadonlyArray<string | undefined> = DEFAULT_CANDIDATES,
  isUsableTmpfs: (candidate: string) => boolean = tmpfsWithRoom,
): string {
  const override = process.env.CORAL_TEST_TMPDIR;
  const base =
    override ??
    candidates.find((candidate): candidate is string => candidate !== undefined && isUsableTmpfs(candidate));
  if (base === undefined) return tmpdir();

  return secureUserRoot(base) ?? tmpdir();
}

/** `TMPDIR` is what `os.tmpdir()` reads on POSIX; `TMP`/`TEMP` cover the Windows lookup order and any child
 *  process that consults them instead. */
export function testTempEnv(): Readonly<Record<string, string>> {
  const root = testTempRoot();
  return { TMPDIR: root, TMP: root, TEMP: root };
}
