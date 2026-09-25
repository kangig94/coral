import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('immutable SQLite open', () => {
  it.each(['-wal', '-shm', '-journal'])('refuses a %s sidecar before immutable reading', (sidecar) => {
    const root = mkdtempSync(join(tmpdir(), 'coral-immutable-sqlite-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const path = join(root, 'history.db');
    const db = runtime.storage.openSqliteDatabaseSync(path);
    db.exec('CREATE TABLE history (id INTEGER PRIMARY KEY)');
    db.close();
    writeFileSync(`${path}${sidecar}`, 'journal bytes');
    expect(() => runtime.storage.openSqliteDatabaseSync(path, { readOnly: true, immutable: true }))
      .toThrow('journal sidecar');
  });
});
