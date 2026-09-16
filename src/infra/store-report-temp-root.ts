import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function prepareStoreReportTempRoot(systemTempRoot: string): string {
  const userId = process.getuid?.();
  const tempRoot = join(systemTempRoot, `coral-store-report-user-${userId ?? 'current'}`);
  try {
    mkdirSync(tempRoot, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const identity = lstatSync(tempRoot, { bigint: true });
  const owned = userId === undefined || identity.uid === BigInt(userId);
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    (process.platform !== 'win32' && (identity.mode & 0o777n) !== 0o700n) ||
    !owned ||
    dirname(realpathSync(tempRoot)) !== realpathSync(systemTempRoot)
  ) {
    throw new Error('Report staging root is not private.');
  }
  return tempRoot;
}
