import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { protectStoreEpoch, resolvedStoreEpoch } from '#src/store/epoch/index.js';
import { createShippedPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('D5 protected epochs against shipped selectors', () => {
  it.each(['v0.10.0', 'v0.10.13'] as const)(
    'requires real-process protected reopen proof before %s can be a crash controller',
    (tag) => {
      const home = mkdtempSync(join(tmpdir(), `coral-shipped-reopen-proof-${tag}-`));
      roots.push(home);
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      openSettledTestStoreDb(runtime).close();
      const epoch = resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1');
      const address = protectStoreEpoch(runtime, epoch);
      const before = digest(join(address.protectedPath, 'store.db'));
      const shipped = createShippedPluginFixture(roots, tag);
      const result = spawnSync(
        process.execPath,
        [
          join(shipped.root, 'bridge', 'coral-backend.cjs'),
          '--probe-retained-epoch',
          JSON.stringify({
            storeRoot: runtime.paths.coral.store.dbDir,
            epoch: '1',
            path: epoch.path,
            lineageKey: address.epochKey,
          }),
          'unproved-controller',
        ],
        {
          env: { ...process.env, HOME: home, TMPDIR: home },
          timeout: 2_000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      expect(result.status === 0 && result.stdout.includes('"kind":"retained-epoch-open"')).toBe(false);
      expect(digest(join(address.protectedPath, 'store.db'))).toBe(before);
    },
    30_000,
  );
});
