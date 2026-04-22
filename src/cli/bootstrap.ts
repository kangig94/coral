import { handleExpansionCommanderFailure, isCommanderDisplayOnlyError } from './commands/expansion.js';
import { buildProgram, emitError } from './main.js';

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
