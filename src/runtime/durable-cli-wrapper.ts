import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export type GroupMemberObservationSubject = Readonly<{
  kind: 'process';
  pid: number | null;
}>;

export type GroupMemberObservationOwnershipAcceptance = Readonly<{
  kind: 'accepted';
  successor: Readonly<{ owner: 'group-member-observation-retention'; acceptance: 'accepted' }>;
}>;

export type GroupMemberObservationTransferred = Readonly<{
  kind: 'transferred';
  subject: GroupMemberObservationSubject;
  successor: Readonly<{ owner: 'group-member-observation-retention'; acceptance: 'accepted' }>;
}>;

export type SettledGroupMemberObservationDisposition =
  | Readonly<{ kind: 'observed'; members: readonly number[] }>
  | Readonly<{
      kind: 'unobservable';
      observation: 'unobservable';
      exit: 'retry-group-observation';
    }>;

export type GroupMemberObservationHold =
  | Readonly<{
      kind: 'held-alive';
      subject: GroupMemberObservationSubject;
      observation: 'alive';
      settled: Promise<void>;
      exit: 'observer-settlement-or-accepted-handoff';
      handoff(): GroupMemberObservationTransferred;
      retry(): Promise<GroupMemberObservationDisposition>;
    }>
  | Readonly<{
      kind: 'held-unobservable';
      subject: GroupMemberObservationSubject;
      observation: 'unobservable';
      settled: Promise<void>;
      exit: 'observer-settlement-or-accepted-handoff';
      handoff(): GroupMemberObservationTransferred;
      retry(): Promise<GroupMemberObservationDisposition>;
    }>;

export type GroupMemberObservationDisposition =
  | SettledGroupMemberObservationDisposition
  | GroupMemberObservationTransferred
  | GroupMemberObservationHold;

type ObservedGroupMembers = Extract<GroupMemberObservationDisposition, { kind: 'observed' }>;

type ContainedGroupObservation =
  | Readonly<{ kind: 'absent'; evidence: ObservedGroupMembers }>
  | Readonly<{ kind: 'alive'; evidence: GroupMemberObservationDisposition }>
  | Readonly<{ kind: 'unobservable'; evidence: GroupMemberObservationDisposition }>;

type FinalizerState =
  | Readonly<{ kind: 'available'; failures: number }>
  | Readonly<{ kind: 'starting' }>
  | Readonly<{ kind: 'attempting'; process: ReturnType<typeof spawn> }>
  | Readonly<{ kind: 'retrying'; failures: number; timer: NodeJS.Timeout }>
  | Readonly<{ kind: 'accepted'; process: ReturnType<typeof spawn> }>;

type ActiveGroupSettlement = {
  kind: 'active';
  exit: PendingExit;
  observationInFlight: boolean;
  observationHold: Extract<GroupMemberObservationDisposition, { kind: 'held-alive' | 'held-unobservable' }> | null;
  poll: NodeJS.Timeout | null;
  finalizer: FinalizerState;
};

type GroupSettlementState = Readonly<{ kind: 'idle' }> | ActiveGroupSettlement | Readonly<{ kind: 'finished' }>;

type GroupSettlementTerminationDisposition =
  | Readonly<{ kind: 'not-started' }>
  | Readonly<{ kind: 'settling' }>
  | Readonly<{ kind: 'finished' }>;

type ContainedGroupSettlement = Readonly<{
  begin(exit: PendingExit): Promise<void>;
  requestTermination(): GroupSettlementTerminationDisposition;
}>;

const groupMemberObservationOwnershipBrand: unique symbol = Symbol('coral.group-member-observation-ownership');

export type GroupMemberObservationOwnership = Readonly<{
  accept(hold: GroupMemberObservationHold): GroupMemberObservationOwnershipAcceptance;
  owns(hold: GroupMemberObservationHold): boolean;
  [groupMemberObservationOwnershipBrand]: true;
}>;

/** A handoff succeeds only after this owner retains the exact unsettled observation. */
export function createGroupMemberObservationOwnership(): GroupMemberObservationOwnership {
  const held = new Set<GroupMemberObservationHold>();
  return {
    accept: (hold) => {
      held.add(hold);
      void hold.settled.then(() => held.delete(hold));
      if (!held.has(hold)) throw new Error('Group-member observation ownership handoff was not accepted.');
      return {
        kind: 'accepted',
        successor: { owner: 'group-member-observation-retention', acceptance: 'accepted' },
      };
    },
    owns: (hold) => held.has(hold),
    [groupMemberObservationOwnershipBrand]: true,
  };
}

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

/** The observation cannot settle until its observer child closes or is observed absent. */
export function groupMembers(
  processGroupId: number,
  time: ReturnType<typeof createRealTimePort>,
  ownership: GroupMemberObservationOwnership,
): Promise<GroupMemberObservationDisposition> {
  return new Promise((resolve) => {
    const observed = spawn('ps', ['-axo', 'pid=,pgid='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let initialDispositionReturned = false;
    let settledDisposition: SettledGroupMemberObservationDisposition | null = null;
    let transferredDisposition: GroupMemberObservationTransferred | null = null;
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
      observed.once('close', resolve);
    });
    const subject: GroupMemberObservationSubject = { kind: 'process', pid: observed.pid ?? null };
    const returnInitialDisposition = (disposition: GroupMemberObservationDisposition): void => {
      if (initialDispositionReturned) return;
      initialDispositionReturned = true;
      time.clearTimeout(timeout);
      resolve(disposition);
    };
    const settle = (disposition: SettledGroupMemberObservationDisposition): void => {
      if (settledDisposition !== null) return;
      settledDisposition = disposition;
      resolveSettled();
      returnInitialDisposition(disposition);
    };
    const retry = async (): Promise<GroupMemberObservationDisposition> => {
      if (transferredDisposition !== null) return transferredDisposition;
      if (settledDisposition !== null) return settledDisposition;
      const held = (observation: 'alive' | 'unobservable'): GroupMemberObservationHold => {
        if (observation === 'alive') {
          return {
            kind: 'held-alive',
            subject,
            observation,
            settled: settled,
            exit: 'observer-settlement-or-accepted-handoff',
            handoff() {
              const acceptance = ownership.accept(this);
              transferredDisposition = { kind: 'transferred', subject, successor: acceptance.successor };
              return transferredDisposition;
            },
            retry,
          };
        }
        return {
          kind: 'held-unobservable',
          subject,
          observation,
          settled: settled,
          exit: 'observer-settlement-or-accepted-handoff',
          handoff() {
            const acceptance = ownership.accept(this);
            transferredDisposition = { kind: 'transferred', subject, successor: acceptance.successor };
            return transferredDisposition;
          },
          retry,
        };
      };
      if (observed.pid === undefined) {
        return held('unobservable');
      }
      gracefulKill(observed as unknown as ChildProcessLike, { time }, observeProcessLiveness);
      try {
        const observation = observeProcessLiveness(observed.pid);
        if (observation === 'absent') {
          const disposition = {
            kind: 'unobservable',
            observation: 'unobservable',
            exit: 'retry-group-observation',
          } as const;
          settle(disposition);
          return disposition;
        }
        if (observation === 'alive') {
          return held(observation);
        }
      } catch {
        // Unknown cannot discharge the observer process obligation.
      }
      return held('unobservable');
    };
    const timeout = time.setTimeout(() => {
      void retry().then(returnInitialDisposition);
    }, GROUP_OBSERVATION_TIMEOUT_MS);
    observed.stdout?.setEncoding('utf8');
    observed.stdout?.on('data', (chunk: string | Buffer) => {
      if (output.length <= 1024 * 1024) output += chunk.toString();
    });
    observed.once('error', () => undefined);
    observed.once('close', (code) => {
      if (code !== 0 || output.length > 1024 * 1024) {
        settle({ kind: 'unobservable', observation: 'unobservable', exit: 'retry-group-observation' });
        return;
      }
      const members: number[] = [];
      for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
        if (match?.[1] === undefined || match[2] === undefined) continue;
        const pid = Number(match[1]);
        if (Number(match[2]) === processGroupId && pid !== observed.pid) members.push(pid);
      }
      settle({ kind: 'observed', members });
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

function createContainedGroupSettlement(
  time: ReturnType<typeof createRealTimePort>,
  closeOutputFiles: () => void,
  terminationRequested: () => boolean,
): ContainedGroupSettlement {
  const ownership = createGroupMemberObservationOwnership();
  const closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const groupHandle: ChildProcessLike = {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdin: null,
    stdout: null,
    stderr: null,
    on(event, listener) {
      if (event === 'close')
        closeListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      return this;
    },
    kill(signal) {
      if (signal === undefined) return false;
      process.kill(-process.pid, signal);
      return true;
    },
  };
  let state: GroupSettlementState = { kind: 'idle' };
  let retainedTermination: NodeJS.Timeout | null = null;

  const classifyObservation = (evidence: GroupMemberObservationDisposition): ContainedGroupObservation => {
    if (evidence.kind === 'observed') {
      return evidence.members.every((pid) => pid === process.pid)
        ? { kind: 'absent', evidence }
        : { kind: 'alive', evidence };
    }
    return evidence.kind === 'held-alive' ? { kind: 'alive', evidence } : { kind: 'unobservable', evidence };
  };

  const observeChildren = async (active: ActiveGroupSettlement): Promise<ContainedGroupObservation> => {
    const evidence =
      active.observationHold === null
        ? await groupMembers(process.pid, time, ownership)
        : await active.observationHold.retry();
    active.observationHold = evidence.kind === 'held-alive' || evidence.kind === 'held-unobservable' ? evidence : null;
    return classifyObservation(evidence);
  };

  function finish(absence: Extract<ContainedGroupObservation, { kind: 'absent' }>): void {
    if (state.kind !== 'active') return;
    if (absence.evidence.members.some((pid) => pid !== process.pid)) return;
    const completed = state;
    state = { kind: 'finished' };
    if (completed.poll !== null) clearInterval(completed.poll);
    if (completed.finalizer.kind === 'retrying') clearTimeout(completed.finalizer.timer);
    if (retainedTermination !== null) clearInterval(retainedTermination);
    for (const listener of closeListeners) listener(null, null);
    const finalizer =
      completed.finalizer.kind === 'attempting' || completed.finalizer.kind === 'accepted'
        ? completed.finalizer.process
        : null;
    if (finalizer?.connected) finalizer.send('cancel');
    closeOutputFiles();
    writeControlExit(completed.exit);
  }

  async function observe(): Promise<void> {
    if (state.kind !== 'active' || state.observationInFlight) return;
    const active = state;
    active.observationInFlight = true;
    try {
      const observation = await observeChildren(active);
      if (observation.kind === 'absent') finish(observation);
    } finally {
      if (state === active) active.observationInFlight = false;
    }
  }

  function retain(): void {
    if (state.kind !== 'active' || retainedTermination !== null) return;
    const active = state;
    retainedTermination = setInterval(() => {
      if (state !== active || active.finalizer.kind === 'accepted') return;
      try {
        groupHandle.kill('SIGTERM');
      } catch {
        // The absence poll must decide whether a rejected signal raced with group disappearance.
      }
      if (active.finalizer.kind === 'available') handoff();
    }, RETAINED_GROUP_TERMINATION_INTERVAL_MS);
    gracefulKill(groupHandle, { time }, observeProcessLiveness);
    handoff();
  }

  function scheduleHandoffRetry(failures: number, retained: boolean): void {
    if (state.kind !== 'active') return;
    const active = state;
    active.finalizer = { kind: 'available', failures };
    if (retained) return;
    const delay = GROUP_FINALIZER_RETRY_DELAYS_MS[failures - 1];
    if (delay === undefined) {
      retain();
      return;
    }
    const timer = setTimeout(() => {
      if (state !== active || active.finalizer.kind !== 'retrying' || active.finalizer.timer !== timer) return;
      active.finalizer = { kind: 'available', failures };
      handoff();
    }, delay);
    active.finalizer = { kind: 'retrying', failures, timer };
    timer.unref?.();
  }

  function handoff(): void {
    if (state.kind !== 'active') return;
    const active = state;
    if (active.finalizer.kind === 'retrying') {
      clearTimeout(active.finalizer.timer);
      active.finalizer = { kind: 'available', failures: active.finalizer.failures };
    }
    if (active.finalizer.kind !== 'available') return;
    const failures = active.finalizer.failures;
    const retained = retainedTermination !== null;
    active.finalizer = { kind: 'starting' };

    let finalizer: ReturnType<typeof spawn>;
    try {
      finalizer = spawn(
        process.execPath,
        [process.argv[1] ?? '', GROUP_FINALIZER_MODE, String(process.pid), JSON.stringify(active.exit)],
        { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
      );
    } catch {
      scheduleHandoffRetry(failures + 1, retained);
      return;
    }
    active.finalizer = { kind: 'attempting', process: finalizer };

    const failAttempt = (): void => {
      if (state !== active || active.finalizer.kind !== 'attempting' || active.finalizer.process !== finalizer) {
        return;
      }
      scheduleHandoffRetry(failures + 1, retained);
    };

    finalizer.once('message', (message: unknown) => {
      if (
        message !== 'ready' ||
        state !== active ||
        active.finalizer.kind !== 'attempting' ||
        active.finalizer.process !== finalizer
      ) {
        return;
      }
      active.finalizer = { kind: 'accepted', process: finalizer };
      if (retainedTermination !== null) {
        clearInterval(retainedTermination);
        retainedTermination = null;
      }
      gracefulKill(groupHandle, { time }, observeProcessLiveness);
    });
    finalizer.once('error', failAttempt);
    finalizer.once('exit', failAttempt);
    finalizer.once('close', failAttempt);
    finalizer.unref();
    finalizer.channel?.unref();
  }

  const begin = async (exit: PendingExit): Promise<void> => {
    if (state.kind !== 'idle') return;
    const active: ActiveGroupSettlement = {
      kind: 'active',
      exit,
      observationInFlight: false,
      observationHold: null,
      poll: null,
      finalizer: { kind: 'available', failures: 0 },
    };
    state = active;
    await observe();
    if (state !== active) return;
    if (terminationRequested()) handoff();
    active.poll = setInterval(() => {
      void observe();
    }, GROUP_OBSERVATION_INTERVAL_MS);
  };

  const requestTermination = (): GroupSettlementTerminationDisposition => {
    if (state.kind === 'idle') return { kind: 'not-started' };
    if (state.kind === 'finished') return { kind: 'finished' };
    handoff();
    return { kind: 'settling' };
  };

  return { begin, requestTermination };
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

  const closeOutputFiles = (): void => {
    try {
      closeSync(stdoutFd);
    } catch {
      // Output-close failure must not prevent process-group settlement.
    }
    try {
      closeSync(stderrFd);
    } catch {
      // Output-close failure must not prevent process-group settlement.
    }
  };

  const groupSettlement = createContainedGroupSettlement(time, closeOutputFiles, () => terminationRequested);

  const terminateChild = (): void => {
    terminationRequested = true;
    publicationGateTermination.abort();
    if (groupSettlement.requestTermination().kind !== 'not-started') return;
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
    void groupSettlement.begin(exit);
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modeOrPayloadPath, processGroupIdArgument, exitArgument] = process.argv.slice(2);
  if (modeOrPayloadPath === GROUP_FINALIZER_MODE) {
    runGroupFinalizer(processGroupIdArgument, exitArgument);
  } else {
    void runWrapper(modeOrPayloadPath);
  }
}
