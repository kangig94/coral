import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { observeProcessLiveness, probeProcessIncarnation } from '../infra/node-process.js';
import type { ChildProcessLike } from '../infra/port-types.js';
import { gracefulKill } from '../infra/process-supervision.js';
import { createRealTimePort } from '../infra/time.js';
import { shouldUseWindowsCommandShell } from '../infra/windows-shell.js';

const [jobDir, command, argsJson, cwdArgument, prompt = '', startTime] = process.argv.slice(2);
if (
  jobDir === undefined ||
  command === undefined ||
  argsJson === undefined ||
  cwdArgument === undefined ||
  startTime === undefined
) {
  throw new Error('Durable wrapper requires job directory, command, arguments, cwd, prompt, and start time.');
}

const args = JSON.parse(argsJson) as string[];
const env = JSON.parse(readFileSync(join(jobDir, 'env.json'), 'utf8')) as NodeJS.ProcessEnv;
const cwd = cwdArgument || undefined;
const stdoutPath = join(jobDir, 'stdout');
const stderrPath = join(jobDir, 'stderr');
const stdoutFd = openSync(stdoutPath, 'w', 0o600);
const stderrFd = openSync(stderrPath, 'w', 0o600);
const time = createRealTimePort();

let child: ReturnType<typeof spawn> | null = null;
let terminationRequested = false;
let terminationStarted = false;
let exitWritten = false;

function terminateChild(): void {
  terminationRequested = true;
  if (child === null || terminationStarted) return;
  terminationStarted = true;
  gracefulKill(child as unknown as ChildProcessLike, { time }, observeProcessLiveness);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, terminateChild);
}

child = spawn(command, args, {
  stdio: ['pipe', stdoutFd, stderrFd],
  cwd,
  env,
  shell: shouldUseWindowsCommandShell(command, process.platform),
});
const childPid = child.pid;
const childStdin = child.stdin;
if (childPid === undefined || childStdin === null) {
  throw new Error('Durable wrapper could not obtain its child process handle.');
}

if (terminationRequested) terminateChild();

const childIncarnation = probeProcessIncarnation(childPid, process.platform);
const leaderIncarnation = probeProcessIncarnation(process.pid, process.platform);
const runtimeRecord = {
  transport: 'durable-cli',
  pid: process.pid,
  stdoutPath,
  stderrPath,
  startTime,
};
const childRoot =
  childIncarnation === null
    ? null
    : {
        pid: childPid,
        incarnation: childIncarnation,
      };
process.stdout.write(JSON.stringify({ type: 'runtime', runtimeRecord, leaderIncarnation, childRoot }) + '\n');

if (prompt) childStdin.write(prompt);
childStdin.end();

function writeExit(code: number | null, signal: NodeJS.Signals | null, exitCode: number): void {
  if (exitWritten) return;
  exitWritten = true;
  try {
    closeSync(stdoutFd);
  } catch {
    // ignored
  }
  try {
    closeSync(stderrFd);
  } catch {
    // ignored
  }
  const exitRecord = { exitCode: code, signal, endTime: new Date().toISOString() };
  process.stdout.write(JSON.stringify({ type: 'exit', exitRecord }) + '\n');
  process.exitCode = exitCode;
}

child.on('close', (code, signal) => writeExit(code, signal, 0));
child.on('error', () => writeExit(null, null, 1));
