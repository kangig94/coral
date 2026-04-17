import { CommanderError } from 'commander';

import { buildProgram, emitError, getOutputFormat } from './main.js';

const program = buildProgram();

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exit(0);
    return;
  }

  emitError(error, getOutputFormat(program));
  process.exit(process.exitCode ?? 1);
});
