import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ExpansionHost } from '#src/expansion/contract.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import type { StoragePort } from '#src/runtime/ports.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';

const REPO_ROOT = process.cwd();

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

function grepFiles(roots: readonly string[], pattern: RegExp): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !path.endsWith('.ts')) {
        continue;
      }
      const text = readFileSync(path, 'utf8');
      if (pattern.test(text)) {
        results.push(relative(REPO_ROOT, path));
      }
    }
  };

  roots.forEach((root) => visit(join(REPO_ROOT, root)));
  return results.sort();
}

describe('expansion consumer registration boundary', () => {
  it('compile-time: ExpansionHost cannot register cursor consumers or host-derived registrationKind', () => {
    const typecheckOnly = false as boolean;
    if (typecheckOnly) {
      const host = null as unknown as ExpansionHost;
      const scope = host.scope;

      // @ts-expect-error cursor consumers are coordinator-startup-owned, not expansion-owned
      host.registerConsumer({ id: 'cursor-expansion', authority: 'journal', kind: 'cursor' }, scope);

      // @ts-expect-error registrationKind is derived by the host, not accepted at the public boundary
      host.registerConsumer({ id: 'stateless', kind: 'stateless', registrationKind: 'stateless' }, scope);
    }

    expect(true).toBe(true);
  });

  it('runtime: ConsumerDriver.register still accepts cursor + expansion directly', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    try {
      const handle = driver.register({
        id: 'cursor-expansion',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'expansion',
      });

      expect(handle.id).toBe('cursor-expansion');
      expect(handle.registrationKind).toBe('expansion');
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('has no production engine declaring the forbidden cursor-expansion combination', () => {
    expect(grepFiles(['src/engines', 'src/expansion'], /\bkind:\s*['"]cursor['"]/)).toEqual([]);
    expect(grepFiles(['src/engines'], /\bregistrationKind:\s*['"]expansion['"]/)).toEqual([]);
  });
});
