declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { dirname, join, resolve } from 'node:path';

import { BackendAlreadyRunningError } from './lock.js';
import { StartupInterruptedError } from './startup-error.js';
import { createCoordinatorServer } from './coordinator.js';
import { backendLog } from '../infra/backend-log.js';
import { nowDate } from '../infra/time.js';
import { createRealRuntime } from '../runtime/real.js';
import type { StoragePort } from '../runtime/ports.js';

function resolveSmokeSchemasDir(storage: Pick<StoragePort, 'existsSync'>): string {
  const entryPath = process.argv[1];
  if (!entryPath) {
    throw new Error('missing entry path');
  }

  const bundleDir = dirname(resolve(entryPath));
  const candidates = [
    join(bundleDir, 'store', 'schemas'),
    join(bundleDir, '..', 'dist', 'store', 'schemas'),
    join(bundleDir, '..', 'store', 'schemas'),
  ];

  for (const candidate of candidates) {
    if (storage.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`bundle schemas not found: ${candidates.join(', ')}`);
}

async function handleSmokeOpenStore(argv: readonly string[]): Promise<number> {
  const pathIdx = argv.indexOf('--path');
  if (pathIdx === -1 || !argv[pathIdx + 1]) {
    backendLog.error('smoke open-store: missing --path');
    return 1;
  }

  try {
    const storePath = argv[pathIdx + 1];
    const { openStoreDatabase } = await import('../store/db.js');
    const { appendEvents } = await import('../store/append.js');
    const { composeReducers } = await import('../store/reducers.js');
    const { createEmptyRegistry } = await import('../store/envelope.js');
    const { getEvent } = await import('../store/queries/events.js');
    const runtime = createRealRuntime();
    const db = openStoreDatabase({
      path: storePath,
      storage: runtime.storage,
      schemasDir: resolveSmokeSchemasDir(runtime.storage),
    });

    try {
      const reducers = composeReducers();
      const upcasters = createEmptyRegistry();
      const readCtx = { schemas: reducers.schemas, upcasters };
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
        { now: () => nowDate(), reducers, upcasters },
      );

      if (!event) {
        backendLog.error('smoke append failed');
        return 1;
      }

      const readBack = getEvent(db, { kind: 'job', id: 'smoke' }, event.seq, readCtx);
      if (!readBack || (readBack.body as { ok?: boolean }).ok !== true) {
        backendLog.error('smoke read-back failed');
        return 1;
      }

      process.stdout.write('ok\n');
      return 0;
    } finally {
      db.close();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    backendLog.error('smoke open-store failed', message);
    return 1;
  }
}

export async function main(): Promise<number> {
  if (process.argv.includes('--smoke-open-store')) {
    return handleSmokeOpenStore(process.argv);
  }

  const coordinator = createCoordinatorServer({
    onStopped: () => {
      process.exit(0);
    },
    onFatalShutdownError: (error) => {
      backendLog.error('Fatal shutdown error', error);
      process.exit(1);
    },
  });

  process.on('SIGTERM', () => {
    void coordinator.shutdown('sigterm').catch(() => {});
  });
  process.on('SIGINT', () => {
    void coordinator.shutdown('sigint').catch(() => {});
  });

  try {
    const info = await coordinator.start();
    backendLog.info(`Running on ${info.host}:${info.port}`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof BackendAlreadyRunningError) {
      backendLog.info(error.message);
      return 0;
    }
    if (error instanceof StartupInterruptedError) {
      return 0;
    }

    backendLog.error('Fatal startup error', error);
    return 1;
  }
}

if (typeof __IS_CORAL_BACKEND_MAIN__ !== 'undefined' && __IS_CORAL_BACKEND_MAIN__) {
  void main()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((error: unknown) => {
      backendLog.error('Fatal startup error', error);
      process.exit(1);
    });
}
