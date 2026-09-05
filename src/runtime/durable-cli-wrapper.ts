import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { observeProcessLiveness, probeProcessIncarnation } from '../infra/node-process.js';
import type { ChildProcessLike } from '../infra/port-types.js';
import { gracefulKill } from '../infra/process-supervision.js';
import { createRealTimePort } from '../infra/time.js';

const GROUP_FINALIZER_MODE = '--finalize-group';
const GROUP_OBSERVATION_INTERVAL_MS = 50;
const GROUP_OBSERVATION_TIMEOUT_MS = 1_000;
const GROUP_FINALIZER_RETRY_DELAYS_MS = [250, 500, 1_000] as const;
const RETAINED_GROUP_TERMINATION_INTERVAL_MS = 1_000;

type LaunchPayload = Readonly<{
  version: 1;
  command: string;
  args: string[];
  cwd: string | null;
  prompt: string;
  startTime: string;
}>;

type PendingExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  wrapperExitCode: number;
}>;

type RuntimeStartPublicationDisposition = Readonly<{ kind: 'published' }> | Readonly<{ kind: 'terminated' }>;

function parseLaunchPayload(payloadPath: string): LaunchPayload {
  let raw: string;
  try {
    raw = readFileSync(payloadPath, 'utf8');
  } finally {
    unlinkSync(payloadPath);
  }
  const parsed = JSON.parse(raw) as Partial<LaunchPayload>;
  if (
    parsed.version !== 1 ||
    typeof parsed.command !== 'string' ||
    !Array.isArray(parsed.args) ||
    parsed.args.some((argument) => typeof argument !== 'string') ||
    (parsed.cwd !== null && typeof parsed.cwd !== 'string') ||
    typeof parsed.prompt !== 'string' ||
    typeof parsed.startTime !== 'string'
  ) {
    throw new Error('Durable wrapper launch payload is invalid.');
  }
  return parsed as LaunchPayload;
}

function groupMembers(
  processGroupId: number,
  time: ReturnType<typeof createRealTimePort>,
): Promise<readonly number[] | null> {
  return new Promise((resolve) => {
    const observed = spawn('ps', ['-axo', 'pid=,pgid='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (members: readonly number[] | null): void => {
      if (settled) return;
      settled = true;
      time.clearTimeout(timeout);
      resolve(members);
    };
    const timeout = time.setTimeout(() => {
      gracefulKill(observed as unknown as ChildProcessLike, { time }, observeProcessLiveness);
      finish(null);
    }, GROUP_OBSERVATION_TIMEOUT_MS);
    observed.stdout?.setEncoding('utf8');
    observed.stdout?.on('data', (chunk: string | Buffer) => {
      if (output.length <= 1024 * 1024) output += chunk.toString();
    });
    observed.once('error', () => finish(null));
    observed.once('close', (code) => {
      if (code !== 0 || output.length > 1024 * 1024) {
        finish(null);
        return;
      }
      const members: number[] = [];
      for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
        if (match?.[1] === undefined || match[2] === undefined) continue;
        const pid = Number(match[1]);
        if (Number(match[2]) === processGroupId && pid !== observed.pid) members.push(pid);
      }
      finish(members);
    });
  });
}

function writeControlExit(exit: PendingExit): void {
  const exitRecord = {
    exitCode: exit.code,
    signal: exit.signal,
    endTime: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify({ type: 'exit', exitRecord }) + '\n');
  process.exitCode = exit.wrapperExitCode;
}

function runGroupFinalizer(processGroupIdArgument: string | undefined, exitArgument: string | undefined): void {
  const processGroupId = Number(processGroupIdArgument);
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0 || exitArgument === undefined) {
    throw new Error('Durable group finalizer requires a process group and exit record.');
  }
  const exit = JSON.parse(exitArgument) as PendingExit;
  const poll = setInterval(() => {
    if (observeProcessLiveness(-processGroupId) !== 'absent') return;
    clearInterval(poll);
    writeControlExit(exit);
  }, GROUP_OBSERVATION_INTERVAL_MS);
  process.on('message', (message: unknown) => {
    if (message !== 'cancel') return;
    clearInterval(poll);
    process.disconnect?.();
    process.exitCode = 0;
  });
  process.send?.('ready');
}

function waitForRuntimeStartPublication(terminationSignal: AbortSignal): Promise<RuntimeStartPublicationDisposition> {
  if (typeof process.send !== 'function') {
    return Promise.reject(new Error('Durable wrapper requires an IPC launch-publication gate.'));
  }
  if (terminationSignal.aborted) {
    process.disconnect();
    return Promise.resolve({ kind: 'terminated' });
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      process.off('disconnect', onDisconnect);
      process.off('message', onMessage);
      terminationSignal.removeEventListener('abort', onTermination);
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(new Error('Durable wrapper lost its coordinator before launch publication completed.'));
    };
    const onMessage = (message: unknown): void => {
      if (message !== 'runtime-start-published') return;
      cleanup();
      process.disconnect();
      resolve({ kind: 'published' });
    };
    const onTermination = (): void => {
      cleanup();
      process.disconnect();
      resolve({ kind: 'terminated' });
    };
    process.once('disconnect', onDisconnect);
    process.on('message', onMessage);
    terminationSignal.addEventListener('abort', onTermination, { once: true });
  });
}

async function runWrapper(payloadPath: string | undefined): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      'Durable CLI launch is unsupported on Windows because Coral cannot observe or terminate a POSIX process group there.',
    );
  }
  if (payloadPath === undefined) throw new Error('Durable wrapper requires a launch payload path.');
  const launch = parseLaunchPayload(payloadPath);
  const jobDir = dirname(payloadPath);
  const env = JSON.parse(readFileSync(join(jobDir, 'env.json'), 'utf8')) as NodeJS.ProcessEnv;
  const stdoutPath = join(jobDir, 'stdout');
  const stderrPath = join(jobDir, 'stderr');
  const stdoutFd = openSync(stdoutPath, 'w', 0o600);
  const stderrFd = openSync(stderrPath, 'w', 0o600);
  const time = createRealTimePort();

  let child: ReturnType<typeof spawn> | null = null;
  let terminationRequested = false;
  const publicationGateTermination = new AbortController();
  let terminationStarted = false;
  let exitWritten = false;
  let pendingExit: PendingExit | null = null;
  let groupPoll: NodeJS.Timeout | null = null;
  let groupObservationInFlight = false;
  let groupFinalizer: ReturnType<typeof spawn> | null = null;
  let groupFinalizerReady = false;
  let groupFinalizerSettled = true;
  let groupFinalizerFailures = 0;
  let groupFinalizerRetry: NodeJS.Timeout | null = null;
  let retainedGroupTermination: NodeJS.Timeout | null = null;
  const groupCloseListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const groupHandle: ChildProcessLike = {
    pid: process.pid,
    stdin: null,
    stdout: null,
    stderr: null,
    on(event, listener) {
      if (event === 'close')
        groupCloseListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      return this;
    },
    kill(signal) {
      if (signal === undefined) return false;
      process.kill(-process.pid, signal);
      return true;
    },
  };

  const closeOutputFiles = (): void => {
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
  };

  const writeExit = (exit: PendingExit): void => {
    if (exitWritten) return;
    exitWritten = true;
    if (groupPoll !== null) clearInterval(groupPoll);
    if (groupFinalizerRetry !== null) clearTimeout(groupFinalizerRetry);
    if (retainedGroupTermination !== null) clearInterval(retainedGroupTermination);
    for (const listener of groupCloseListeners) listener(null, null);
    if (groupFinalizer?.connected) groupFinalizer.send('cancel');
    closeOutputFiles();
    writeControlExit(exit);
  };

  const containedChildrenAreAbsent = async (): Promise<boolean> => {
    const members = await groupMembers(process.pid, time);
    return members !== null && members.every((pid) => pid === process.pid);
  };

  function exerciseRetainedGroupTermination(exit: PendingExit): void {
    if (exitWritten || groupFinalizerReady) return;
    try {
      groupHandle.kill('SIGTERM');
    } catch {
      // The absence poll must decide whether a rejected signal raced with group disappearance.
    }
    if (groupFinalizerSettled && groupFinalizerRetry === null) handExitToGroupFinalizer(exit, true);
  }

  function retainGroupTerminationAuthority(exit: PendingExit): void {
    if (retainedGroupTermination !== null) return;
    retainedGroupTermination = setInterval(() => {
      exerciseRetainedGroupTermination(exit);
    }, RETAINED_GROUP_TERMINATION_INTERVAL_MS);
    gracefulKill(groupHandle, { time }, observeProcessLiveness);
    handExitToGroupFinalizer(exit, true);
  }

  function handExitToGroupFinalizer(exit: PendingExit, retainedAuthority = false): void {
    if (exitWritten || groupFinalizerReady || !groupFinalizerSettled || groupFinalizerRetry !== null) return;
    groupFinalizerSettled = false;

    function scheduleRetry(): void {
      if (exitWritten || groupFinalizerReady) return;
      if (retainedAuthority) return;
      const delay = GROUP_FINALIZER_RETRY_DELAYS_MS[groupFinalizerFailures];
      groupFinalizerFailures += 1;
      if (delay === undefined) {
        retainGroupTerminationAuthority(exit);
        return;
      }
      groupFinalizerRetry = setTimeout(() => {
        groupFinalizerRetry = null;
        handExitToGroupFinalizer(exit);
      }, delay);
      groupFinalizerRetry.unref?.();
    }

    let finalizer: ReturnType<typeof spawn>;
    try {
      finalizer = spawn(
        process.execPath,
        [process.argv[1] ?? '', GROUP_FINALIZER_MODE, String(process.pid), JSON.stringify(exit)],
        { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
      );
    } catch {
      groupFinalizerSettled = true;
      scheduleRetry();
      return;
    }
    groupFinalizer = finalizer;
    let attemptSettled = false;

    const failAttempt = (): void => {
      if (attemptSettled) return;
      attemptSettled = true;
      groupFinalizerSettled = true;
      if (groupFinalizer === finalizer) groupFinalizer = null;
      scheduleRetry();
    };

    finalizer.once('message', (message: unknown) => {
      if (message !== 'ready' || attemptSettled) return;
      attemptSettled = true;
      groupFinalizerReady = true;
      groupFinalizerSettled = true;
      if (retainedGroupTermination !== null) {
        clearInterval(retainedGroupTermination);
        retainedGroupTermination = null;
      }
      gracefulKill(groupHandle, { time }, observeProcessLiveness);
    });
    finalizer.once('error', failAttempt);
    finalizer.once('exit', failAttempt);
    finalizer.once('close', failAttempt);
    finalizer.unref();
    finalizer.channel?.unref();
  }

  const observeContainedGroup = async (exit: PendingExit): Promise<void> => {
    if (groupObservationInFlight || exitWritten) return;
    groupObservationInFlight = true;
    try {
      if (await containedChildrenAreAbsent()) writeExit(exit);
    } finally {
      groupObservationInFlight = false;
    }
  };

  const settleContainedGroup = async (exit: PendingExit): Promise<void> => {
    if (pendingExit !== null) return;
    pendingExit = exit;
    if (await containedChildrenAreAbsent()) {
      writeExit(exit);
      return;
    }

    if (terminationRequested) handExitToGroupFinalizer(exit);
    groupPoll = setInterval(() => {
      void observeContainedGroup(exit);
    }, GROUP_OBSERVATION_INTERVAL_MS);
  };

  const terminateChild = (): void => {
    terminationRequested = true;
    publicationGateTermination.abort();
    if (pendingExit !== null) {
      if (groupFinalizerRetry !== null) {
        clearTimeout(groupFinalizerRetry);
        groupFinalizerRetry = null;
      }
      if (retainedGroupTermination === null) handExitToGroupFinalizer(pendingExit);
      else handExitToGroupFinalizer(pendingExit, true);
      return;
    }
    if (child === null || terminationStarted) return;
    terminationStarted = true;
    gracefulKill(child as unknown as ChildProcessLike, { time }, observeProcessLiveness);
  };

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, terminateChild);
  }

  const publicationDisposition = await waitForRuntimeStartPublication(publicationGateTermination.signal);
  if (publicationDisposition.kind === 'terminated') {
    closeOutputFiles();
    return;
  }
  child = spawn(launch.command, launch.args, {
    stdio: ['pipe', stdoutFd, stderrFd],
    cwd: launch.cwd ?? undefined,
    env,
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
    startTime: launch.startTime,
  };
  const childRoot =
    childIncarnation === null
      ? null
      : {
          pid: childPid,
          incarnation: childIncarnation,
        };
  let childCompletionSettled = false;
  const settleChildCompletion = (exit: PendingExit): void => {
    if (childCompletionSettled) return;
    childCompletionSettled = true;
    void settleContainedGroup(exit);
  };
  child.once('close', (code, signal) => {
    settleChildCompletion({ code, signal, wrapperExitCode: 0 });
  });
  child.once('error', () => {
    settleChildCompletion({ code: null, signal: null, wrapperExitCode: 1 });
  });
  childStdin.on('error', () => undefined);
  process.stdout.write(JSON.stringify({ type: 'runtime', runtimeRecord, leaderIncarnation, childRoot }) + '\n');

  if (launch.prompt) childStdin.write(launch.prompt);
  childStdin.end();
}

const [modeOrPayloadPath, processGroupIdArgument, exitArgument] = process.argv.slice(2);
if (modeOrPayloadPath === GROUP_FINALIZER_MODE) {
  runGroupFinalizer(processGroupIdArgument, exitArgument);
} else {
  void runWrapper(modeOrPayloadPath);
}
