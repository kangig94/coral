import { mkdirSync, statfsSync } from 'node:fs';
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
 * Falls back to the platform temp directory whenever a memory-backed root is absent or too small, so a
 * container with a 64 MiB `/dev/shm`, a macOS runner, and a CI image without one all keep working unchanged.
 * `CORAL_TEST_TMPDIR` overrides the choice outright. `candidates` is a parameter so the fallback itself is
 * reachable from a test on a host that does have a usable tmpfs.
 */
export function testTempRoot(candidates: ReadonlyArray<string | undefined> = DEFAULT_CANDIDATES): string {
  const override = process.env.CORAL_TEST_TMPDIR;
  const base =
    override ??
    candidates.find((candidate): candidate is string => candidate !== undefined && tmpfsWithRoom(candidate));
  if (base === undefined) return tmpdir();

  const root = join(base, 'coral-tests');
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    return tmpdir();
  }
  return root;
}

/** `TMPDIR` is what `os.tmpdir()` reads on POSIX; `TMP`/`TEMP` cover the Windows lookup order and any child
 *  process that consults them instead. */
export function testTempEnv(): Readonly<Record<string, string>> {
  const root = testTempRoot();
  return { TMPDIR: root, TMP: root, TEMP: root };
}
