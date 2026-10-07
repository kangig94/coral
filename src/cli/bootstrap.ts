import { runCli } from './run.js';

// A reader that closes stdout fails every later write. A write whose outcome matters observes that through its own
// callback, so the stream's error event is only acknowledged here; unheard, it would crash the CLI with a stack.
process.stdout.on('error', () => undefined);

// The bundled CLI entrypoint is CommonJS, so top-level await is unavailable. The invocation lives here
// rather than in run.ts so that importing the CLI does not execute it — see runCli in run.ts.
export const bootstrapCompletion = runCli();

void bootstrapCompletion;
