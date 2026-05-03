import '../runtime/suppress-experimental-warnings.js';

declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;
declare const __PLUGIN_ROOT__: string | undefined;

import { dirname } from 'node:path';

import { BackendAlreadyRunningError } from './handoff.js';
import { StartupInterruptedError } from './startup-error.js';
import { createCoordinatorServer } from './index.js';
import { backendLog } from '../infra/backend-log.js';
import { readBundleHash } from '../infra/bundle-manifest.js';
import { errorMessage } from '../infra/error-format.js';
import { pluginRootNamespace } from '../infra/plugin-identity.js';
import { nowDate } from '../infra/time.js';
import { noProviderLookupPort } from '../providers/catalog.js';
import { createRealRuntime } from '../runtime/real.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { serializeCoralSetupError } from '../runtime/errors.js';

async function handleSmokeOpenStore(argv: readonly string[]): Promise<number> {
  const pathIdx = argv.indexOf('--path');
  if (pathIdx === -1 || !argv[pathIdx + 1]) {
    backendLog.error('smoke open-store: missing --path');
    return 1;
  }

  try {
    const storePath = argv[pathIdx + 1];
    const { openWritableStoreDbNoReset } = await import('../store/db.js');
    const { commit } = await import('../store/append.js');
    const { composeReducers } = await import('../store/reducers.js');
    const { createDefaultUpcasterRegistry } = await import('../store/upcaster-registry.js');
    const { getEvent } = await import('../store/event-queries.js');
    const runtime = createRealRuntime(resolveBuildFlavor(process.env));
    const db = openWritableStoreDbNoReset(runtime, {
      path: storePath,
    });

    try {
      const reducers = composeReducers();
      const upcasters = createDefaultUpcasterRegistry();
      const readCtx = { schemas: reducers.schemas, upcasters };
      const [event] = commit(
        db,
        (c) => {
          c.append({
            type: 'smoke.ping',
            stream: { kind: 'job', id: 'smoke' },
            bodyVersion: 1,
            body: { ok: true },
          });
          return undefined;
        },
        { now: () => nowDate(runtime.time), reducers, upcasters, providers: noProviderLookupPort },
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
    const message = errorMessage(error);
    backendLog.error('smoke open-store failed', message);
    return 1;
  }
}

function writeStartupErrorSentinel(pluginRoot: string, error: unknown): void {
  const setupError = serializeCoralSetupError(error);
  if (!setupError) return;

  const attemptId = process.env.CORAL_STARTUP_ATTEMPT_ID;
  if (!attemptId) return;

  try {
    const flavor = resolveBuildFlavor(process.env);
    const runtime = createRealRuntime(flavor);
    const startupErrorFile = runtime.paths.coral.coordinator.startupErrorFile;
    const startedAt = Number(process.env.CORAL_STARTUP_STARTED_AT);
    const sentinel = {
      version: 1,
      attemptId,
      pid: process.pid,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
      socketPath: runtime.paths.coral.coordinator.socketPath,
      bundleHash: readBundleHash(pluginRoot),
      flavor,
      namespace: pluginRootNamespace(pluginRoot),
      error: setupError,
    };
    const tmp = `${startupErrorFile}.tmp-${process.pid}-${attemptId}`;
    runtime.storage.mkdirSync(dirname(startupErrorFile), { recursive: true });
    runtime.storage.writeFileSync(tmp, JSON.stringify(sentinel) + '\n');
    runtime.storage.renameSync(tmp, startupErrorFile);
  } catch (sentinelError: unknown) {
    backendLog.error('Failed to write startup setup-error sentinel', sentinelError);
  }
}

export async function main(): Promise<number> {
  if (process.argv.includes('--smoke-open-store')) {
    return handleSmokeOpenStore(process.argv);
  }

  if (typeof __PLUGIN_ROOT__ !== 'string') {
    throw new Error('Coral backend bootstrap requires __PLUGIN_ROOT__ to be defined at build time.');
  }

  const coordinator = createCoordinatorServer({
    pluginRoot: __PLUGIN_ROOT__,
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

  // Hold a ref'd keepalive for the duration of startup. Without it, a contender
  // entering `bindWithHandoff`'s retry sleep can drain the event loop and exit
  // silently with code 0: `runtime.time.sleep` uses `timer.unref()` (real.ts),
  // and no other ref-holding I/O exists between IPC client close and the next
  // bind attempt. After `start()` resolves the bound IPC + HTTP servers keep
  // the loop alive on their own.
  const startupKeepalive = setInterval(() => {}, 60_000);

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
    writeStartupErrorSentinel(__PLUGIN_ROOT__, error);
    return 1;
  } finally {
    clearInterval(startupKeepalive);
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
