declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;
declare const __PLUGIN_ROOT__: string | undefined;

import { auditBootstrapFailure, writeBootstrapDiagnostic, writeStartupErrorSentinel } from './bootstrap-diagnostics.js';
import { BackendAlreadyRunningError } from './handoff.js';
import {
  HandoffRunError,
  consumeHandoffRunResult,
  runHandoff,
  type HandoffPublicationIncident,
} from './handoff-runner.js';
import { createCoordinatorServer } from './index.js';
import { StartupStoreHandoffError } from './lifecycle.js';
import { runKbDaemonMain } from '../kb-daemon/daemon-main.js';
import { backendLog } from '../infra/backend-log.js';
import { shedInheritedClaudeCodeEnv } from '../infra/env-sanitize.js';
import { errorMessage } from '../infra/error-format.js';
import { CoralSetupError } from '../runtime/errors.js';
import { createRealRuntime } from '../runtime/real.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { resolveStrictBundleIdentity } from '../infra/bundle-manifest.js';
import { parseProviderRoleArgv, type ProviderRole } from '../provider-proxy/role-argv.js';
import { runProviderRoleMain } from '../provider-proxy/role-main.js';
import { currentCoralStoreFormat } from '../store-format.js';

/**
 * Exit codes for a guardian/reaper/proxy role that failed to start, distinct from `0` (success), `1` (a
 * coordinator's own generic startup failure), and `70` (`--print-store-reset-build-identity`'s own strict
 * identity failure) — and distinct per role, so an operator reading the exit code alone knows which role
 * process failed without needing to correlate it against a log line.
 */
const PROVIDER_ROLE_STARTUP_FAILURE_EXIT_CODES: Readonly<Record<ProviderRole, number>> = Object.freeze({
  guardian: 71,
  reaper: 72,
  proxy: 73,
});

async function handleSmokeOpenStore(argv: readonly string[]): Promise<number> {
  const pathIdx = argv.indexOf('--path');
  if (pathIdx === -1 || !argv[pathIdx + 1]) {
    backendLog.error('smoke open-store: missing --path');
    return 1;
  }

  try {
    const storePath = argv[pathIdx + 1];
    const { openWritableStoreDbNoReset } = await import('../store/db.js');
    const runtime = createRealRuntime(resolveBuildFlavor(process.env));
    const db = openWritableStoreDbNoReset(runtime, {
      path: storePath,
      storeFormat: currentCoralStoreFormat(),
    });

    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TEMP TABLE coral_smoke_open_store (ok INTEGER NOT NULL CHECK (ok = 1))');
      db.exec('INSERT INTO coral_smoke_open_store (ok) VALUES (1)');
      const readBack = db.prepare<[], { ok: number }>('SELECT ok FROM coral_smoke_open_store').get();
      db.exec('DROP TABLE coral_smoke_open_store');
      db.exec('COMMIT');
      if (readBack?.ok !== 1) {
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

export async function handoffStartupToSelectedBuild(
  pluginRoot: string,
  startupError: StartupStoreHandoffError,
): Promise<Readonly<{ kind: 'started' }> | Readonly<{ kind: 'failed'; error: unknown }>> {
  try {
    const result = await runHandoff(
      { kind: 'backend-startup' },
      {
        pluginRoot,
        activeSelectionTarget: startupError.target,
        onSelectionPublicationIncident: logStartupHandoffPublicationIncident,
      },
    );
    const continuation = consumeHandoffRunResult(result, (incidents) =>
      incidents.filter((incident) => incident.phase === 'terminal').forEach(logStartupHandoffPublicationIncident),
    );
    if (continuation.kind === 'run-current') {
      return {
        kind: 'failed',
        error: new Error('Selected backend startup handoff did not delegate to the selected build.'),
      };
    }
    switch (continuation.outcome.kind) {
      case 'handoff-success':
        return { kind: 'started' };
      case 'handoff-exit':
        return {
          kind: 'failed',
          error: new Error(
            `Selected backend exited during startup handoff with code ${continuation.outcome.exitCode}.`,
          ),
        };
      case 'handoff-signal':
        return {
          kind: 'failed',
          error: new Error(
            `Selected backend exited during startup handoff from signal ${continuation.outcome.signal}.`,
          ),
        };
    }
  } catch (error: unknown) {
    if (error instanceof HandoffRunError) {
      error.incidents.filter((incident) => incident.phase === 'terminal').forEach(logStartupHandoffPublicationIncident);
      return { kind: 'failed', error: error.originalError };
    }
    return { kind: 'failed', error };
  }
}

function logStartupHandoffPublicationIncident(incident: HandoffPublicationIncident): void {
  backendLog.warn(`Backend startup handoff routing-status publication incident: ${JSON.stringify(incident)}`);
}

export async function main(): Promise<number> {
  // Before any child spawn, shed the Claude Code identity inherited from the daemon's launcher.
  shedInheritedClaudeCodeEnv(process.env);

  if (process.argv.includes('--print-store-format-fingerprint')) {
    process.stdout.write(`${currentCoralStoreFormat().fingerprint}\n`);
    return 0;
  }

  if (process.argv.length === 3 && process.argv[2] === '--print-store-reset-build-identity') {
    const identity = resolveStrictBundleIdentity();
    if (!identity.ok) return 70;
    process.stdout.write(`${JSON.stringify(identity.manifest)}\n`);
    return 0;
  }

  // Provider-proxy role dispatch runs before ordinary coordinator construction: a guardian, reaper, or proxy
  // process is a role of this same backend artifact, never a coordinator. Parsing lives in `role-argv.ts`
  // and running in `role-main.ts` — this is dispatch only.
  const providerRole = parseProviderRoleArgv(process.argv);
  if (providerRole.role !== 'none') {
    try {
      return await runProviderRoleMain(providerRole, {
        pluginRoot: typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : process.cwd(),
      });
    } catch (error: unknown) {
      // A guardian/reaper/proxy role failing to start is not a coordinator startup failure — it must not
      // reach `writeBootstrapDiagnostic`/`auditBootstrapFailure` below, which are the coordinator's own
      // diagnostic surface, or an operator reading them would see a role's own crash reported as if this
      // process had tried and failed to become the backend itself. Distinct codes, mirroring this file's own
      // `70` for `--print-store-reset-build-identity`, are what let the two be told apart from the outside.
      backendLog.error(`Provider ${providerRole.role} role failed to start`, error);
      return PROVIDER_ROLE_STARTUP_FAILURE_EXIT_CODES[providerRole.role];
    }
  }

  if (process.env.CORAL_KB_DAEMON === '1') {
    return runKbDaemonMain({
      pluginRoot: typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : process.cwd(),
    });
  }

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
    // A cancelled startup keeps its exit code; what it may not do is drop the obligation silently, so the
    // outstanding settlement is recorded before the cancellation is honoured.
    if (error instanceof CoralSetupError && error.code === 'handoff_pending_signal_aborted') {
      backendLog.warn(`${error.userMessage} ${error.remediation}`);
      const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'startup_failed', error, 0);
      auditBootstrapFailure(
        'bootstrap_startup_aborted_pending_signal',
        __PLUGIN_ROOT__,
        'startup_failed',
        error,
        0,
        diagnosticFile,
      );
      return 0;
    }
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      return 0;
    }

    let startupError = error;
    if (error instanceof StartupStoreHandoffError) {
      const handoff = await handoffStartupToSelectedBuild(__PLUGIN_ROOT__, error);
      if (handoff.kind === 'started') return 0;
      startupError = handoff.error;
    }

    backendLog.error('Fatal startup error', startupError);
    const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'startup_failed', startupError, 1);
    writeStartupErrorSentinel(__PLUGIN_ROOT__, startupError, diagnosticFile);
    auditBootstrapFailure(
      'bootstrap_startup_failed',
      __PLUGIN_ROOT__,
      'startup_failed',
      startupError,
      1,
      diagnosticFile,
    );
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
