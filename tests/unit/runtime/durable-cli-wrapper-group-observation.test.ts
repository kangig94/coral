import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ChildProcessLike } from '#src/infra/port-types.js';
import { groupMembers } from '#src/runtime/durable-cli-wrapper.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

const processHarness = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: processHarness.spawn }));
vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: () => 'unknown',
  probeProcessIncarnation: vi.fn(),
}));

describe('durable wrapper group observation', () => {
  it('keeps an unobservable timed-out observer joined until process close', async () => {
    const events = new EventEmitter();
    const kill = vi.fn(() => true);
    const child = {
      pid: 4_242,
      stdin: null,
      stdout: new PassThrough(),
      stderr: null,
      kill,
      on: events.on.bind(events),
      once: events.once.bind(events),
    } as unknown as ChildProcessLike;
    processHarness.spawn.mockReturnValueOnce(child);
    const time = new VirtualTime();
    const sleep = vi
      .spyOn(time, 'sleep')
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => new Promise<void>(() => undefined));
    let settled = false;
    const observation = groupMembers(9_999, time).finally(() => {
      settled = true;
    });

    time.tick(1_000);
    await flushMicrotasks();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);
    expect(sleep).not.toHaveBeenCalled();

    time.tick(5_000);
    await flushMicrotasks();
    expect(settled).toBe(false);

    events.emit('close', null, 'SIGTERM');
    await expect(observation).resolves.toBeNull();
  });
});
