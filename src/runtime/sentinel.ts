import { spawn, type ChildProcess, type SendHandle } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Server, Socket } from 'node:net';
import { constants as osConstants } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { SENTINEL_TIMING, validSentinelTiming, type SentinelTiming } from '../infra/sentinel-timing.js';

export type SentinelMessage =
  | { kind: 'coral-sentinel-hello'; id: string }
  | { kind: 'coral-sentinel-armed'; id: string }
  | { kind: 'coral-sentinel-challenge'; id: number }
  | { kind: 'coral-sentinel-answer'; id: number }
  | { kind: 'coral-sentinel-child'; pid: number }
  | { kind: 'coral-sentinel-retire-child' }
  | { kind: 'coral-sentinel-upstream-disconnected' };

function sentinelMessage(value: unknown): value is SentinelMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    value.kind.startsWith('coral-sentinel-')
  );
}

function childIsUninterruptible(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    // The command name is parenthesized and may contain spaces or ')' itself.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2] === 'D';
  } catch {
    return false;
  }
}

function closeRelayedHandle(handle: unknown): void {
  if (handle instanceof Server) handle.close();
  else if (handle instanceof Socket) handle.destroy();
}

function writeSentinelRecord(runDir: string | undefined, id: string, record: Readonly<Record<string, unknown>>): void {
  if (runDir === undefined || !isAbsolute(runDir)) return;
  const directory = join(runDir, 'coordinator-sentinel.v1');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error: unknown) {
    process.stderr.write(`Coordinator sentinel could not record ${String(record.state)}: ${String(error)}\n`);
  }
}

/** The parent-held ChildProcess is the only signal authority for this incarnation. */
export async function runCoordinatorSentinel(
  executable: string,
  args: readonly string[],
  options: Readonly<{ timing?: SentinelTiming; onChild?: (child: ChildProcess) => void }> = {},
): Promise<number> {
  const timing = options.timing ?? SENTINEL_TIMING;
  if (!validSentinelTiming(timing)) throw new Error('Invalid coordinator sentinel timing');
  const id = randomUUID();
  const startedAt = Date.now();
  const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
  const record = (state: string, fields: Record<string, unknown> = {}): void => {
    writeSentinelRecord(runDir, id, {
      version: 1,
      sentinelId: id,
      sentinelPid: process.pid,
      executable,
      startedAt,
      timing,
      state,
      ...fields,
    });
  };
  record('prepared');
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CORAL_SENTINEL_ID: id },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let armed = false;
  let helloPending = false;
  const acknowledgeArm = (): void => {
    if (!armed || !helloPending || !child.connected) return;
    helloPending = false;
    child.send({ kind: 'coral-sentinel-armed', id } satisfies SentinelMessage);
  };
  child.on('message', (message: unknown) => {
    if (sentinelMessage(message) && message.kind === 'coral-sentinel-hello' && message.id === id) {
      helloPending = true;
      acknowledgeArm();
    }
  });
  options.onChild?.(child);
  const spawned = await new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!spawned || child.pid === undefined) return 1;
  record('armed', { coordinatorPid: child.pid });
  armed = true;
  acknowledgeArm();
  process.send?.({ kind: 'coral-sentinel-child', pid: child.pid } satisfies SentinelMessage);

  let lastWake = Date.now();
  let lastAnswer = lastWake;
  let outstanding: number | null = null;
  let sequence = 0;
  let escalationAt: number | null = null;
  let killed = false;
  let channelAvailable = true;
  let schedulingGaps = 0;
  const reset = (now: number): void => {
    lastAnswer = now;
    outstanding = null;
    escalationAt = null;
    killed = false;
  };
  const tick = (): void => {
    const now = Date.now();
    if (now - lastWake > timing.schedulingGapMs) {
      schedulingGaps += 1;
      reset(now);
    }
    lastWake = now;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (escalationAt !== null) {
      if (!killed && now - escalationAt >= timing.graceMs) {
        if (child.pid !== undefined && childIsUninterruptible(child.pid)) reset(now);
        else {
          record('killing', { coordinatorPid: child.pid, lastAnswer, schedulingGaps });
          child.kill('SIGKILL');
          killed = true;
        }
      }
      return;
    }
    if (now - lastAnswer >= timing.lapseMs) {
      if (child.pid !== undefined && childIsUninterruptible(child.pid)) reset(now);
      else {
        record('terminating', { coordinatorPid: child.pid, lastAnswer, schedulingGaps });
        child.kill('SIGTERM');
        escalationAt = now;
      }
      return;
    }
    if (channelAvailable && outstanding === null) {
      outstanding = ++sequence;
      child.send({ kind: 'coral-sentinel-challenge', id: outstanding } satisfies SentinelMessage, (error) => {
        if (error) channelAvailable = false;
      });
    }
  };
  const interval = setInterval(tick, timing.challengeMs);
  tick();
  child.on('message', (message: unknown, handle: unknown) => {
    if (sentinelMessage(message)) {
      if (message.kind === 'coral-sentinel-answer' && message.id === outstanding) {
        lastAnswer = Date.now();
        outstanding = null;
        escalationAt = null;
        killed = false;
      }
      return;
    }
    if (process.connected) {
      process.send?.(message as Parameters<NonNullable<typeof process.send>>[0], handle as SendHandle, () => {
        closeRelayedHandle(handle);
      });
    } else closeRelayedHandle(handle);
  });
  child.on('disconnect', () => {
    channelAvailable = false;
  });
  process.on('message', (message: unknown, handle: unknown) => {
    if (sentinelMessage(message)) {
      if (
        message.kind === 'coral-sentinel-retire-child' &&
        escalationAt === null &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const now = Date.now();
        record('terminating', { coordinatorPid: child.pid, lastAnswer, schedulingGaps, reason: 'succession-attempt' });
        child.kill('SIGTERM');
        escalationAt = now;
      }
      return;
    }
    if (child.connected) {
      child.send(message as Parameters<typeof child.send>[0], handle as SendHandle, () => {
        closeRelayedHandle(handle);
      });
    } else closeRelayedHandle(handle);
  });
  process.on('disconnect', () => {
    if (child.connected) child.send({ kind: 'coral-sentinel-upstream-disconnected' } satisfies SentinelMessage);
  });
  return exited.then(({ code, signal }) => {
    clearInterval(interval);
    const exitCode = code ?? (signal === null ? 1 : 128 + osConstants.signals[signal]);
    record('exited', {
      coordinatorPid: child.pid,
      exitCode,
      childExitCode: code,
      childSignal: signal,
      lastAnswer,
      schedulingGaps,
      cleanup: 'retained-for-startup-reclamation',
    });
    if (child.connected) child.disconnect();
    if (process.connected) process.disconnect();
    return exitCode;
  });
}
