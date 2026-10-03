import { pruneJobExports, type ExportJobRetentionState } from '#src/jobs/export-retention.js';
import { createRetentionFixture, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function exported(f: ReturnType<typeof createRetentionFixture>, id: string): string {
  const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
  mkdirSync(join(path, 'provider-artifacts'), { recursive: true });
  writeFileSync(join(path, 'result.md'), 'durable result');
  writeFileSync(join(path, 'provider-artifacts', 'original.jsonl'), 'provider session');
  for (const child of ['', 'result.md', 'provider-artifacts', 'provider-artifacts/original.jsonl'])
    utimesSync(join(path, child), 1, 1);
  return path;
}
async function prune(
  f: ReturnType<typeof createRetentionFixture>,
  states: Record<string, ExportJobRetentionState>,
  holds: Record<string, 'released' | 'required' | 'unknown'> = {},
) {
  return pruneJobExports({
    db: f.db,
    runtime: f.runtime,
    cutoff: RETENTION_CUTOFF,
    afterId: '',
    budget: f.budget,
    jobState: (id) => states[id] ?? { kind: 'absent' },
    resultHold: (id) => holds[id] ?? 'released',
    mutate: (operation) => operation(),
  });
}

it('commits recovery evidence before the first deletion after a crash between rename and evidence commit', async () => {
  const f = createRetentionFixture(true);
  fixtures.push(f);
  const root = f.runtime.paths.coral.exports.jobsRoot;
  exported(f, 'rename-crash');
  const rename = f.runtime.storage.renameSync;
  f.runtime.storage.renameSync = (from, to) => {
    rename(from, to);
    throw new Error('crash after rename before evidence commit');
  };
  await prune(f, {});
  f.runtime.storage.renameSync = rename;
  const retirement = readdirSync(root).find((name) => name.startsWith('.retiring-'))!;
  const key = `storage-retention.exports.retirement.v1.${retirement}`;
  expect(f.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)).toBeUndefined();
  // No committed evidence exists to explain rename freshness; recovery must conservatively wait
  // until the independently observed tree is expired before admitting it again.
  for (const child of ['', 'result.md', 'provider-artifacts', 'provider-artifacts/original.jsonl'])
    utimesSync(join(root, retirement, child), 1, 1);
  const unlink = f.runtime.storage.unlinkSync;
  let checked = false;
  f.runtime.storage.unlinkSync = (path) => {
    const reader = f.runtime.storage.openSqliteDatabaseSync(join(f.baseDir, 'store.db'), { readOnly: true });
    try {
      expect(reader.prepare('SELECT value FROM meta WHERE key = ?').get(key)).toBeDefined();
    } finally {
      reader.close();
    }
    checked = true;
    unlink(path);
  };
  await prune(f, {});
  expect(checked).toBe(true);
  expect(readdirSync(root)).toEqual([]);
});
