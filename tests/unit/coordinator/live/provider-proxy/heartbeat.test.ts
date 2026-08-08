import { describe, expect, it, vi } from 'vitest';

import { startHeartbeatLoop } from '#src/coordinator/live/provider-proxy/heartbeat.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { PROXY_CONTROL_HEARTBEAT_MS } from '#src/provider-proxy/orphan-deadline.js';
import type { Runtime } from '#src/runtime/ports.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

type RecordedCall = Readonly<{ controlEpoch: number; heartbeatChallenge: string }>;

/** Answers each `call` with the next scripted reply — a challenge string to echo `state: 'active'`, or an
 *  `Error` to reject with. The last entry repeats once exhausted, so a test can assert on ticks past its
 *  scripted list without needing one entry per tick. */
function scriptedClient(replies: readonly (string | Error)[]): { client: ControlClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const client: ControlClient = {
    call: (_method, params) => {
      calls.push(params as RecordedCall);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve({ state: 'active', nextHeartbeatChallenge: reply });
    },
    close: () => {},
  };
  return { client, calls };
}

function runtimeWithTime(time: VirtualTime): Runtime {
  return { time } as unknown as Runtime;
}

describe('startHeartbeatLoop', () => {
  it('echoes the current challenge on every tick and carries the reply into the next one', async () => {
    const time = new VirtualTime();
    const { client, calls } = scriptedClient(['challenge-1', 'challenge-2']);
    const loop = startHeartbeatLoop(client, 'control.heartbeat.v1', runtimeWithTime(time), 7, 'challenge-0', () => {});

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(calls).toEqual([
      { controlEpoch: 7, heartbeatChallenge: 'challenge-0' },
      { controlEpoch: 7, heartbeatChallenge: 'challenge-1' },
    ]);
    loop.stop();
  });

  it('reports a failed echo through onError and keeps ticking on the unchanged challenge rather than retrying early', async () => {
    const time = new VirtualTime();
    const { client, calls } = scriptedClient([new Error('endpoint unreachable'), 'challenge-recovered']);
    const errors: unknown[] = [];
    const loop = startHeartbeatLoop(
      client,
      'control.heartbeat.v1',
      runtimeWithTime(time),
      3,
      'challenge-0',
      (error) => {
        errors.push(error);
      },
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('endpoint unreachable');

    // Not retried early: the next attempt still waits a full interval, and resends the same challenge the
    // failed one carried rather than one advanced past a reply that never arrived.
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(calls).toEqual([
      { controlEpoch: 3, heartbeatChallenge: 'challenge-0' },
      { controlEpoch: 3, heartbeatChallenge: 'challenge-0' },
    ]);
    loop.stop();
  });

  it('stop() clears the interval on the runtime, not just its own internal flag', async () => {
    const time = new VirtualTime();
    // A spy on `clearInterval` itself, not just an absence of later calls: the loop's own `stopped` flag
    // already short-circuits `tick()` on its own, so asserting no further calls would pass even if `stop()`
    // forgot to release the runtime's timer handle.
    const clearIntervalSpy = vi.spyOn(time, 'clearInterval');
    const { client, calls } = scriptedClient(['challenge-1']);
    const loop = startHeartbeatLoop(client, 'control.heartbeat.v1', runtimeWithTime(time), 1, 'challenge-0', () => {});

    loop.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    time.tick(PROXY_CONTROL_HEARTBEAT_MS * 3);
    await flushMicrotasks();

    expect(calls).toEqual([]);
  });
});
