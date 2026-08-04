import { handleExpansionCommanderFailure, isCommanderDisplayOnlyError } from './commands/expansion.js';
import { emitError } from './emit.js';
import { buildProgram, parseProgramWithHandoff } from './program.js';
import { isStoreResetReportInvocation } from './store-reset-signal.js';
import { resolveStrictBundleIdentity } from '../infra/bundle-manifest.js';

/**
 * Runs one CLI invocation against the current `process.argv`.
 *
 * Deliberately separate from `bootstrap.ts`, which is the esbuild entrypoint and invokes this at module
 * load. Keeping the invocation out of this module is what makes the CLI testable: a self-executing entry
 * forces tests to re-import it through `vi.resetModules()` to get a fresh run, which charges a cold
 * transform of the whole command graph to whichever test imports first. Callers here can invoke repeatedly
 * on one already-transformed module instead. Do not move the invocation back into this file.
 */
export function runCli(): Promise<unknown> {
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
  // Keep the process alive while async command handlers are still awaiting unref'ed runtime timers such as
  // coordinator startup polling.
  const parseKeepAlive = setInterval(() => undefined, 2 ** 31 - 1);
  return parseProgramWithHandoff(program)
    .then((handoff) => {
      // A delegated invocation ran in the newer build; this process only mirrors how that child ended.
      if (handoff === null || handoff.kind === 'handoff-success') return;
      if (handoff.kind === 'handoff-exit') {
        process.exitCode = handoff.exitCode;
        return;
      }
      process.kill(process.pid, handoff.signal);
    })
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
