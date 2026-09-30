import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { createStoreChildPrincipalCredentials } from '#src/coordinator/child-principal-credentials.js';
import type { IdPort } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';

import { newRawDatabase } from './test-db.js';

/** A store.db stand-in carrying only the `meta` table child credentials live in. */
export function childCredentialDatabase(): Database {
  const db = newRawDatabase(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

export function testChildPrincipalRegistry(
  ids: Pick<IdPort, 'randomBytes'>,
  options: Readonly<{
    db?: Database;
    namespace?: string;
    activeJobOrigin?: (jobId: string) => string | null;
  }> = {},
): ChildPrincipalRegistry {
  const db = options.db ?? childCredentialDatabase();
  return new ChildPrincipalRegistry(
    ids,
    createStoreChildPrincipalCredentials(() => db),
    {
      namespace: options.namespace ?? 'ns-a',
      activeJobOrigin: options.activeJobOrigin ?? (() => 'ns-a'),
    },
  );
}
