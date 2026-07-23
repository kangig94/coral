import { handleExpansionCommanderFailure, isCommanderDisplayOnlyError } from './commands/expansion.js';
import { emitError } from './emit.js';
import { buildProgram } from './program.js';
import { isStoreResetReportInvocation } from './store-reset-signal.js';
import { resolveStrictBundleIdentity } from '../infra/bundle-manifest.js';

// The bundled CLI entrypoint is CommonJS, so top-level await is unavailable.
// Keep the process alive while async command handlers are still awaiting
// unref'ed runtime timers such as coordinator startup polling.
function runBootstrap(): Promise<unknown> {
  if (process.argv.length === 3 && process.argv[2] === '--print-store-reset-build-identity') {
    const identity = resolveStrictBundleIdentity();
    if (!identity.ok) {
      process.exitCode = 70;
      return Promise.resolve();
    }
    process.stdout.write(`${JSON.stringify(identity.manifest)}\n`);
    return Promise.resolve();
  }

  const ownsDiagnosticSignals = isStoreResetReportInvocation(process.argv.slice(2));
  const shutdownController = ownsDiagnosticSignals ? new AbortController() : null;
  const onSigint = (): void => {
    process.exitCode = 130;
    shutdownController?.abort();
  };
  const onSigterm = (): void => {
    process.exitCode = 143;
    shutdownController?.abort();
  };
  if (ownsDiagnosticSignals) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }
  const program = buildProgram(undefined, { shutdownSignal: shutdownController?.signal });
  const parseKeepAlive = setInterval(() => undefined, 2 ** 31 - 1);
  return program
    .parseAsync(process.argv)
    .catch((error) => {
      if (isCommanderDisplayOnlyError(error)) {
        process.exitCode = 0;
        return;
      }

      if (handleExpansionCommanderFailure(error, process.argv, { exit: true })) {
        return;
      }

      emitError(error);
      process.exit(process.exitCode ?? 1);
    })
    .finally(() => {
      clearInterval(parseKeepAlive);
      if (ownsDiagnosticSignals) {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
      }
    });
}

export const bootstrapCompletion = runBootstrap();

void bootstrapCompletion;
