import { buildProgram, emitError, getOutputFormat } from './main.js';

const program = buildProgram();

program.parseAsync(process.argv).catch((error) => {
  emitError(error, getOutputFormat(program));
  process.exit(1);
});
