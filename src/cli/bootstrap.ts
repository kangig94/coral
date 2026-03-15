import {
  buildProgram,
  emitError,
  getOutputFormat,
  normalizeProviderArgv,
} from './main.js';

const program = buildProgram();

program.parseAsync(normalizeProviderArgv(process.argv)).catch((error) => {
  emitError(error, getOutputFormat(program));
  process.exit(1);
});
