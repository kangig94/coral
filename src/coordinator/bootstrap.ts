declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;
declare const __PLUGIN_ROOT__: string | undefined;

import { auditBootstrapFailure, writeBootstrapDiagnostic, writeStartupErrorSentinel } from './bootstrap-diagnostics.js';
import { BackendAlreadyRunningError } from './handoff.js';
import {
  HandoffRunError,
  consumeHandoffRunResult,
  runHandoff,
  type DelegatedStartupObservation,
  type HandoffPublicationIncident,
} from './handoff-routing/runner.js';
import type { UnresolvedIncumbentCause } from './handoff-routing/policy.js';
import type { handoffRoutingStatusExitContribution } from './handoff-routing/status.js';
import { createCoordinatorServer } from './index.js';
import { StartupStoreHandoffError } from './lifecycle.js';
import { runKbDaemonMain } from '../kb-daemon/daemon-main.js';
import { backendLog } from '../infra/backend-log.js';
import { assertNever } from '../infra/error-format.js';
import { shedInheritedClaudeCodeEnv } from '../infra/env-sanitize.js';
import { errorMessage } from '../infra/error-format.js';
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

/**
 * A nonzero exit says this process did not discharge its obligation; a `startup_failed` diagnostic says the
 * startup failed. Delegated startup nobody could observe is the first and not the second, so it takes an exit
 * code and no diagnostic. The value must stay the one `handoffRoutingStatusExitContribution`
 * (src/coordinator/handoff-routing/status.ts) contributes for the invocation this process leaves unresolved:
 * `coral-backend` and `coral-cli backend status` may not make the same claim with two different numbers.
 */
const UNOBSERVED_STARTUP_DELEGATION_EXIT_CODE: ReturnType<typeof handoffRoutingStatusExitContribution> = 75;

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

/**
 * `undetermined` is not a quiet `failed`: it may not reach a diagnostic, a sentinel, or an audit event, since
 * every one of those records a startup failure this process did not observe.
 */
type DelegatedStartupResult =
  | Readonly<{ kind: 'started' }>
  | Readonly<{ kind: 'failed'; error: unknown; exitCode: number }>
  | Readonly<{ kind: 'undetermined'; cause: UnresolvedIncumbentCause }>;

function delegatedStartupResult(observation: DelegatedStartupObservation): DelegatedStartupResult {
  switch (observation.kind) {
    case 'serving':
      return { kind: 'started' };
    case 'not-serving': {
      const { childEnding } = observation;
      if (childEnding.signal !== null) {
        return {
          kind: 'failed',
          error: new Error(`Selected backend ended during startup handoff from signal ${childEnding.signal}.`),
          exitCode: 1,
        };
      }
      // Exiting 0 without taking over is still a failure to become the backend, so this process must exit
      // nonzero. The child's own code is the record's; forcing it here would not reach the record.
      return {
        kind: 'failed',
        error: new Error(
          `Selected backend exited during startup handoff with code ${childEnding.code ?? 'unreported'} without ` +
            'taking over as the coordinator.',
        ),
        exitCode: childEnding.code === null || childEnding.code === 0 ? 1 : childEnding.code,
      };
    }
    case 'undetermined':
      return { kind: 'undetermined', cause: observation.cause };
    default:
      return assertNever(observation);
  }
}

export async function handoffStartupToSelectedBuild(
  pluginRoot: string,
  startupError: StartupStoreHandoffError,
): Promise<DelegatedStartupResult> {
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
    return continuation.kind === 'run-current'
      ? {
          kind: 'failed',
          error: new Error('Selected backend startup handoff did not delegate to the selected build.'),
          exitCode: 1,
        }
      : delegatedStartupResult(continuation.observation);
  } catch (error: unknown) {
    if (error instanceof HandoffRunError) {
      error.incidents.filter((incident) => incident.phase === 'terminal').forEach(logStartupHandoffPublicationIncident);
      return { kind: 'failed', error: error.originalError, exitCode: 1 };
    }
    return { kind: 'failed', error, exitCode: 1 };
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

  // Hold a ref'd keepalive for the duration of startup. Without it, a contender
  // entering `bindWithHandoff`'s retry sleep can drain the event loop and exit
  // silently with code 0: `runtime.time.sleep` uses `timer.unref()` (real.ts),
  // and no other ref-holding I/O exists between IPC client close and the next
  // bind attempt. After `start()` resolves the bound IPC + HTTP servers keep
  // the loop alive on their own.
  const startupKeepalive = setInterval(() => {}, 60_000);

  try {
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

    let startupError = error;
    let startupExitCode = 1;
    if (error instanceof StartupStoreHandoffError) {
      const handoff = await handoffStartupToSelectedBuild(__PLUGIN_ROOT__, error);
      switch (handoff.kind) {
        case 'started':
          return 0;
        case 'undetermined':
          backendLog.warn(
            `This process delegated startup to the selected Coral build and could not observe whether that build ` +
              `is now serving (${handoff.cause}). No startup failure is recorded, because none was observed. Run ` +
              `'coral-cli backend status' to see whether the selected build is serving, and to settle the routing ` +
              `invocation this process left unresolved.`,
          );
          return UNOBSERVED_STARTUP_DELEGATION_EXIT_CODE;
        case 'failed':
          startupError = handoff.error;
          startupExitCode = handoff.exitCode;
          break;
        default:
          return assertNever(handoff);
      }
    }

    backendLog.error('Fatal startup error', startupError);
    const diagnosticFile = writeBootstrapDiagnostic(__PLUGIN_ROOT__, 'startup_failed', startupError, startupExitCode);
    writeStartupErrorSentinel(__PLUGIN_ROOT__, startupError, diagnosticFile);
    auditBootstrapFailure(
      'bootstrap_startup_failed',
      __PLUGIN_ROOT__,
      'startup_failed',
      startupError,
      startupExitCode,
      diagnosticFile,
    );
    return startupExitCode;
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
