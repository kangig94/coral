import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import {
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '#src/infra/process-containment.js';
import { MAX_PROXY_RECORDED_PROVIDER_ROOTS } from '#src/provider-proxy/enforcement.js';
import { createRealRuntime } from '#src/runtime/real.js';

const runtime = createRealRuntime('dev');
const cleanupTargets = new Map<number, RecordedProcessIdentity>();
const cleanupGroups = new Set<number>();
const containmentClockScope = Symbol('process-containment-integration');

const clock = createMonotonicClock(containmentClockScope, {
  sleep: async (ms): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  },
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for process state.');
}

async function readStdoutLine(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  if (stdout === null) throw new Error('Expected child stdout to be piped.');
  return await new Promise<string>((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for child stdout.')), 5_000);
    const finish = (error?: Error, line?: string): void => {
      clearTimeout(timeout);
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      if (error !== undefined) reject(error);
      else resolve(line ?? '');
    };
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline !== -1) finish(undefined, buffered.slice(0, newline));
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('Child exited before reporting its process id.'));
    stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function spawnDetached(source: string, output = false): ChildProcess {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    detached: true,
    stdio: output ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  if (child.pid === undefined) throw new Error('Detached child did not receive a process id.');
  cleanupGroups.add(child.pid);
  return child;
}

async function recordProcess(pid: number): Promise<RecordedProcessIdentity> {
  await waitFor(() => probeProcessIncarnation(pid) !== null);
  const incarnation = probeProcessIncarnation(pid);
  if (incarnation === null) throw new Error(`Process ${pid} exited before identity recording.`);
  const identity = { pid, incarnation };
  cleanupTargets.set(pid, identity);
  return identity;
}

function containmentFor(identity: RecordedProcessIdentity): RecordedContainmentIdentity {
  return { ...identity, processGroupId: identity.pid };
}

function environment(
  signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }>,
): ProcessContainmentEnvironment<typeof containmentClockScope> {
  return {
    clock,
    process: {
      isAlive: runtime.process.isAlive,
      kill: (pid, signal) => {
        signals.push({ pid, signal });
        return runtime.process.kill(pid, signal);
      },
    },
    platform: process.platform,
    maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  };
}

function linuxProcessState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    return closeParen === -1 ? null : (stat.slice(closeParen + 2).split(/\s+/, 1)[0] ?? null);
  } catch {
    return null;
  }
}

afterEach(async () => {
  for (const [pid, identity] of cleanupTargets) {
    if (probeProcessIncarnation(pid) !== identity.incarnation) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // best effort after a failed assertion
    }
  }
  for (const groupId of cleanupGroups) {
    try {
      process.kill(-groupId, 'SIGKILL');
    } catch {
      // best effort after a failed assertion
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  cleanupTargets.clear();
  cleanupGroups.clear();
});

describe('real recorded process containment', () => {
  // @flaky — process scheduling and OS signal delivery are timing-sensitive.
  it('creates and signals a detached group as one containment', { retry: 2 }, async () => {
    const leader = spawnDetached(
      `
          import { spawn } from 'node:child_process';
          const child = spawn(process.execPath, ['--input-type=module', '--eval', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
          });
          console.log(child.pid);
          setInterval(() => {}, 1000);
        `,
      true,
    );
    const leaderIdentity = await recordProcess(leader.pid as number);
    const memberPid = Number.parseInt(await readStdoutLine(leader), 10);
    if (!Number.isSafeInteger(memberPid)) throw new Error('Group member did not report a valid process id.');
    await recordProcess(memberPid);
    process.kill(leaderIdentity.pid, 'SIGKILL');
    await waitFor(() => !isAlive(leaderIdentity.pid));
    expect(isAlive(memberPid)).toBe(true);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

    await reapRecordedContainment(
      containmentFor(leaderIdentity),
      [],
      clock.shiftMilliseconds(clock.now(), 12_000),
      environment(signals),
    );

    expect(signals).toContainEqual({ pid: -leaderIdentity.pid, signal: 'SIGTERM' });
    expect(isAlive(leaderIdentity.pid)).toBe(false);
    expect(isAlive(memberPid)).toBe(false);
  });

  // @flaky — process scheduling and OS signal delivery are timing-sensitive.
  it.skipIf(process.platform !== 'linux')(
    'signals a recorded provider root directly after it leaves the proxy group',
    { retry: 2 },
    async () => {
      const leader = spawnDetached(
        `
          import { spawn } from 'node:child_process';
          const escaped = spawn('setsid', [process.execPath, '--input-type=module', '--eval', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
          });
          console.log(escaped.pid);
          setInterval(() => {}, 1000);
        `,
        true,
      );
      const leaderIdentity = await recordProcess(leader.pid as number);
      const escapedPid = Number.parseInt(await readStdoutLine(leader), 10);
      if (!Number.isSafeInteger(escapedPid)) throw new Error('Escaped root did not report a valid process id.');
      const escapedIdentity = await recordProcess(escapedPid);
      cleanupGroups.add(escapedPid);

      process.kill(leaderIdentity.pid, 'SIGKILL');
      await waitFor(() => !isAlive(leaderIdentity.pid));
      expect(isAlive(escapedPid)).toBe(true);
      const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

      await reapRecordedContainment(
        containmentFor(leaderIdentity),
        [escapedIdentity],
        clock.shiftMilliseconds(clock.now(), 12_000),
        environment(signals),
      );

      expect(signals).toContainEqual({ pid: escapedPid, signal: 'SIGTERM' });
      expect(isAlive(escapedPid)).toBe(false);
    },
  );

  // @flaky — process scheduling and OS signal delivery are timing-sensitive.
  it.skipIf(process.platform !== 'linux')(
    'reports success for the recorded set while an unrecorded escapee survives',
    { retry: 2 },
    async () => {
      // The other half of the setsid split. A recorded root that leaves the group is still reached by
      // identity; an unrecorded descendant is not, and never was — Coral never learned that pid exists.
      // Asserting Coral kills it would encode a guarantee no pid- or group-based primitive can make, so the
      // honest assertion is that every *recorded* target is absent and success is scoped to exactly those.
      const leader = spawnDetached(
        `
          import { spawn } from 'node:child_process';
          const escapee = spawn('setsid', [process.execPath, '--input-type=module', '--eval', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
          });
          console.log(escapee.pid);
          setInterval(() => {}, 1000);
        `,
        true,
      );
      const leaderIdentity = await recordProcess(leader.pid as number);
      const escapeePid = Number.parseInt(await readStdoutLine(leader), 10);
      if (!Number.isSafeInteger(escapeePid)) throw new Error('Escapee did not report a valid process id.');
      // The harness owns this pid; it is deliberately never handed to the reap call.
      cleanupGroups.add(escapeePid);

      await reapRecordedContainment(
        containmentFor(leaderIdentity),
        [],
        clock.shiftMilliseconds(clock.now(), 12_000),
        environment([]),
      );

      expect(isAlive(leaderIdentity.pid)).toBe(false);
      expect(isAlive(escapeePid)).toBe(true);
    },
  );

  // @flaky — process scheduling and OS signal delivery are timing-sensitive.
  it('does not signal a live process whose pid has a different recorded start time', { retry: 2 }, async () => {
    const child = spawnDetached('setInterval(() => {}, 1000);');
    const actualIdentity = await recordProcess(child.pid as number);
    const recycledIdentity = {
      ...actualIdentity,
      incarnation: testIncarnation('recycled'),
    };
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

    await reapRecordedContainment(
      containmentFor(recycledIdentity),
      [],
      clock.shiftMilliseconds(clock.now(), 2_000),
      environment(signals),
    );

    expect(signals).toEqual([]);
    expect(isAlive(actualIdentity.pid)).toBe(true);
  });

  // @flaky — process scheduling and OS signal delivery are timing-sensitive.
  it.skipIf(process.platform !== 'linux')('removes a SIGSTOPped containment with SIGKILL', { retry: 2 }, async () => {
    const child = spawnDetached('setInterval(() => {}, 1000);');
    const identity = await recordProcess(child.pid as number);
    process.kill(identity.pid, 'SIGSTOP');
    await waitFor(() => linuxProcessState(identity.pid) === 'T');
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

    await reapRecordedContainment(
      containmentFor(identity),
      [],
      clock.shiftMilliseconds(clock.now(), 12_000),
      environment(signals),
    );

    expect(signals).toContainEqual({ pid: -identity.pid, signal: 'SIGKILL' });
    expect(isAlive(identity.pid)).toBe(false);
  });
});
