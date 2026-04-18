import { dirname, join, resolve } from 'node:path';

import { createRealRuntime, type RuntimeStorage } from './runtime.js';

function resolveSmokeMigrationsDir(storage: Pick<RuntimeStorage, 'existsSync'>): string {
  const entryPath = process.argv[1];
  if (!entryPath) {
    throw new Error('missing entry path');
  }

  const bundleDir = dirname(resolve(entryPath));
  const candidates = [
    join(bundleDir, 'store', 'migrations'),
    join(bundleDir, '..', 'dist', 'store', 'migrations'),
    join(bundleDir, '..', 'store', 'migrations'),
  ];

  for (const candidate of candidates) {
    if (storage.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`bundle migrations not found: ${candidates.join(', ')}`);
}

export async function handleSmokeOpenStore(argv: readonly string[]): Promise<number> {
  const pathIdx = argv.indexOf('--path');
  if (pathIdx === -1 || !argv[pathIdx + 1]) {
    process.stderr.write('missing --path\n');
    return 1;
  }

  try {
    const storePath = argv[pathIdx + 1]!;
    const { openStoreDatabase } = await import('../store/db.js');
    const { appendEvents } = await import('../store/append.js');
    const { composeReducers } = await import('../store/reducers.js');
    const { createEmptyRegistry } = await import('../store/envelope.js');
    const { getEvent } = await import('../store/queries/events.js');
    const runtime = createRealRuntime();
    const db = openStoreDatabase({
      path: storePath,
      storage: runtime.storage,
      migrationsDir: resolveSmokeMigrationsDir(runtime.storage),
    });

    try {
      const reducers = composeReducers();
      const upcasters = createEmptyRegistry();
      const [event] = appendEvents(
        db,
        [
          {
            type: 'smoke.ping',
            stream: { kind: 'job', id: 'smoke' },
            bodyVersion: 1,
            body: { ok: true },
          },
        ],
        { now: () => new Date(), reducers, upcasters },
      );

      if (!event) {
        process.stderr.write('smoke append failed\n');
        return 1;
      }

      const readBack = getEvent(db, { kind: 'job', id: 'smoke' }, event.seq);
      if (!readBack || (readBack.body as { ok?: boolean }).ok !== true) {
        process.stderr.write('smoke read-back failed\n');
        return 1;
      }

      process.stdout.write('ok\n');
      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`smoke open-store failed: ${message}\n`);
    return 1;
  }
}
