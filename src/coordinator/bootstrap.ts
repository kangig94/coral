declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;
declare const __PLUGIN_ROOT__: string | undefined;

import { auditBootstrapFailure, writeBootstrapDiagnostic, writeStartupErrorSentinel } from './bootstrap-diagnostics.js';
import { BackendAlreadyRunningError } from './handoff.js';
import { createCoordinatorServer } from './index.js';
import { backendLog } from '../infra/backend-log.js';
import { shedInheritedClaudeCodeEnv } from '../infra/env-sanitize.js';
import { errorMessage } from '../infra/error-format.js';
import { nowDate } from '../infra/time.js';
import { noProviderLookupPort } from '../providers/catalog.js';
import { createRealRuntime } from '../runtime/real.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';

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

export async function main(): Promise<number> {
  // Before any child spawn, shed the Claude Code identity inherited from the daemon's launcher.
  shedInheritedClaudeCodeEnv(process.env);

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
      const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'fatal_shutdown_error', error, 1);
      auditBootstrapFailure(
        'bootstrap_fatal_shutdown',
        __PLUGIN_ROOT__,
        'fatal_shutdown_error',
        error,
        1,
        diagnosticFile,
      );
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
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      return 0;
    }

    backendLog.error('Fatal startup error', error);
    const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'startup_failed', error, 1);
    writeStartupErrorSentinel(__PLUGIN_ROOT__, error, diagnosticFile);
    auditBootstrapFailure('bootstrap_startup_failed', __PLUGIN_ROOT__, 'startup_failed', error, 1, diagnosticFile);
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
      if (typeof __PLUGIN_ROOT__ === 'string') {
        const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'bootstrap_unhandled_rejection', error, 1);
        auditBootstrapFailure(
          'bootstrap_unhandled_rejection',
          __PLUGIN_ROOT__,
          'bootstrap_unhandled_rejection',
          error,
          1,
          diagnosticFile,
        );
      }
      process.exit(1);
    });
}
