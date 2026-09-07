import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ChildProcessLike } from '#src/infra/port-types.js';
import { createGroupMemberObservationOwnership, groupMembers } from '#src/runtime/durable-cli-wrapper.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

const processHarness = vi.hoisted(() => ({
  spawn: vi.fn(),
  observeProcessLiveness: vi.fn<() => 'alive' | 'absent' | 'unknown'>(),
}));

vi.mock('node:child_process', () => ({ spawn: processHarness.spawn }));
vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: processHarness.observeProcessLiveness,
  probeProcessIncarnation: vi.fn(),
}));

describe('durable wrapper group observation', () => {
  it('returns an unobservable timed-out observer as a joinable hold', async () => {
    const events = new EventEmitter();
    const kill = vi.fn(() => true);
    const exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    const child = {
      pid: 4_242,
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      stdin: null,
      stdout: new PassThrough(),
      stderr: null,
      kill,
      on: events.on.bind(events),
      once: events.once.bind(events),
    } as unknown as ChildProcessLike;
    processHarness.spawn.mockReturnValueOnce(child);
    processHarness.observeProcessLiveness.mockReturnValue('unknown');
    const time = new VirtualTime();
    const sleep = vi
      .spyOn(time, 'sleep')
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => new Promise<void>(() => undefined));
    const ownership = createGroupMemberObservationOwnership();
    const observation = groupMembers(9_999, time, ownership);

    time.tick(1_000);
    await flushMicrotasks();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(sleep).not.toHaveBeenCalled();

    const disposition = await observation;
    expect(disposition).toMatchObject({
      kind: 'held-unobservable',
      observation: 'unobservable',
      subject: { kind: 'process', pid: 4_242 },
      exit: 'observer-settlement-or-accepted-handoff',
    });
    if (disposition.kind !== 'held-unobservable') {
      throw new Error('Expected the observer obligation to remain held.');
    }
    expect(disposition.handoff()).toEqual({
      kind: 'transferred',
      subject: { kind: 'process', pid: 4_242 },
      successor: { owner: 'group-member-observation-retention', acceptance: 'accepted' },
    });
    expect(ownership.owns(disposition)).toBe(true);
    await expect(disposition.retry()).resolves.toEqual({
      kind: 'transferred',
      subject: { kind: 'process', pid: 4_242 },
      successor: { owner: 'group-member-observation-retention', acceptance: 'accepted' },
    });

    signalCode = 'SIGTERM';
    events.emit('exit', exitCode, signalCode);
    events.emit('close', exitCode, signalCode);
    await disposition.settled;
    await flushMicrotasks();
    expect(ownership.owns(disposition)).toBe(false);
    await expect(disposition.retry()).resolves.toEqual({
      kind: 'transferred',
      subject: { kind: 'process', pid: 4_242 },
      successor: { owner: 'group-member-observation-retention', acceptance: 'accepted' },
    });
  });

  it('settles without awaiting close when exact observer absence is observed', async () => {
    const events = new EventEmitter();
    const kill = vi.fn(() => true);
    const child = {
      pid: 4_243,
      exitCode: null,
      signalCode: null,
      stdin: null,
      stdout: new PassThrough(),
      stderr: null,
      kill,
      on: events.on.bind(events),
      once: events.once.bind(events),
    } as unknown as ChildProcessLike;
    processHarness.spawn.mockReturnValueOnce(child);
    processHarness.observeProcessLiveness.mockReturnValue('absent');
    const time = new VirtualTime();
    const observation = groupMembers(9_999, time, createGroupMemberObservationOwnership());

    time.tick(1_000);
    await flushMicrotasks();

    await expect(observation).resolves.toEqual({
      kind: 'unobservable',
      observation: 'unobservable',
      exit: 'retry-group-observation',
    });
  });

  it('distinguishes a live timed-out observer from an unobservable one', async () => {
    const events = new EventEmitter();
    const child = {
      pid: 4_244,
      exitCode: null,
      signalCode: null,
      stdin: null,
      stdout: new PassThrough(),
      stderr: null,
      kill: vi.fn(() => true),
      on: events.on.bind(events),
      once: events.once.bind(events),
    } as unknown as ChildProcessLike;
    processHarness.spawn.mockReturnValueOnce(child);
    processHarness.observeProcessLiveness.mockReturnValue('alive');
    const time = new VirtualTime();
    const observation = groupMembers(9_999, time, createGroupMemberObservationOwnership());

    time.tick(1_000);
    await flushMicrotasks();

    await expect(observation).resolves.toMatchObject({
      kind: 'held-alive',
      observation: 'alive',
      subject: { kind: 'process', pid: 4_244 },
    });
  });

  it('returns parsed members only after a successful observer close', async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    let exitCode: number | null = null;
    const signalCode: NodeJS.Signals | null = null;
    const child = {
      pid: 4_245,
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      stdin: null,
      stdout,
      stderr: null,
      kill: vi.fn(() => true),
      on: events.on.bind(events),
      once: events.once.bind(events),
    } as unknown as ChildProcessLike;
    processHarness.spawn.mockReturnValueOnce(child);
    const time = new VirtualTime();
    const observation = groupMembers(9_999, time, createGroupMemberObservationOwnership());

    stdout.write('101 9999\n4245 9999\n202 8888\n');
    await flushMicrotasks();
    exitCode = 0;
    events.emit('exit', exitCode, signalCode);
    events.emit('close', exitCode, signalCode);

    await expect(observation).resolves.toEqual({ kind: 'observed', members: [101] });
  });
});
