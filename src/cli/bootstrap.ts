import { runCli } from './run.js';

process.stdout.on('error', () => undefined);

// The bundled CLI entrypoint is CommonJS, so top-level await is unavailable. The invocation lives here
// rather than in run.ts so that importing the CLI does not execute it — see runCli in run.ts.
export const bootstrapCompletion = runCli();

void bootstrapCompletion;
