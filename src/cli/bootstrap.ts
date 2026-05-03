import '../runtime/suppress-experimental-warnings.js';

import { handleExpansionCommanderFailure, isCommanderDisplayOnlyError } from './commands/expansion.js';
import { emitError } from './emit.js';
import { buildProgram } from './program.js';

const program = buildProgram();
const parseKeepAlive = setInterval(() => undefined, 2 ** 31 - 1);

// The bundled CLI entrypoint is CommonJS, so top-level await is unavailable.
// Keep the process alive while async command handlers are still awaiting
// unref'ed runtime timers such as coordinator startup polling.
void program
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
