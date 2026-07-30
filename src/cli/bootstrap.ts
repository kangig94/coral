import { runCli } from './run.js';

// The bundled CLI entrypoint is CommonJS, so top-level await is unavailable. Export the in-flight promise
// instead so the bundle keeps a reference to it. The invocation lives here rather than in run.ts so that
// importing the CLI does not execute it — see the note in run.ts.
export const bootstrapCompletion = runCli();

void bootstrapCompletion;
