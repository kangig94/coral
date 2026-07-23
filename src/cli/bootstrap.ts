import { handleExpansionCommanderFailure, isCommanderDisplayOnlyError } from './commands/expansion.js';
import { emitError } from './emit.js';
import { buildProgram } from './program.js';
import { resolveStrictBundleIdentity } from '../infra/bundle-manifest.js';

// The bundled CLI entrypoint is CommonJS, so top-level await is unavailable.
// Keep the process alive while async command handlers are still awaiting
// unref'ed runtime timers such as coordinator startup polling.
function runBootstrap(): Promise<unknown> {
  if (process.argv.includes('--print-store-reset-build-identity')) {
    const identity = resolveStrictBundleIdentity();
    if (!identity.ok) {
      process.exitCode = 70;
      return Promise.resolve();
    }
    process.stdout.write(`${JSON.stringify(identity.manifest)}\n`);
    return Promise.resolve();
  }

  const program = buildProgram();
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
    });
}

export const bootstrapCompletion = runBootstrap();

void bootstrapCompletion;
