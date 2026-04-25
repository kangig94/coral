import { handleExpansionCommanderFailure, isCommanderDisplayOnlyError } from './commands/expansion.js';
import { emitError } from './emit.js';
import { buildProgram } from './program.js';

const program = buildProgram();

program.parseAsync(process.argv).catch((error) => {
  if (isCommanderDisplayOnlyError(error)) {
    process.exitCode = 0;
    return;
  }

  if (handleExpansionCommanderFailure(error, process.argv, { exit: true })) {
    return;
  }

  emitError(error);
  process.exit(process.exitCode ?? 1);
});
