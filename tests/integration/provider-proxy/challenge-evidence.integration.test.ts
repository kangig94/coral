const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { createBootstrapNonceCredential } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  createControlEndpoint,
  type ControlMethod,
  type ControlTenancyHolder,
} from '#src/provider-proxy/control-endpoint.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import {
  createEnforcerDeadlineStateMachine,
  resolveProviderProxyDeadlineConfiguration,
} from '#src/provider-proxy/orphan-deadline.js';

const NONCE = 'a'.repeat(64);

/** Fixture holder identities must be deterministic and collision-free by credential name. */
function holderFor(instanceId: string): ControlTenancyHolder {
  return { instanceId, pid: 1, incarnation: testIncarnation(instanceId) };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Frame = Readonly<{ method: string; body: unknown }>;

function call(socketPath: string, frames: ReadonlyArray<(previous: unknown) => Frame>): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    cleanups.push(() => {
      socket.destroy();
    });
    const results: unknown[] = [];
    let buffer = '';
    let index = 0;
    const send = (): void => {
      const frame = frames[index](results.at(-1));
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: frame.method, params: frame.body })}\n`);
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const message = JSON.parse(buffer.slice(0, newline)) as { result?: unknown; error?: { message: string } };
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (message.error !== undefined) {
          reject(new Error(message.error.message));
          return;
        }
        results.push(message.result);
        index += 1;
        if (index === frames.length) {
          resolve(results);
          return;
        }
        send();
      }
    });
    socket.once('error', reject);
    socket.once('connect', send);
  });
}

describe('control heartbeats reach the deadline machine', () => {
  it('advances the enforcer deadlines on every accepted echo', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-evidence-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const socketPath = join(directory, 'g.sock');

    let elapsed = 0n;
    const clock = createMonotonicClock(Symbol('evidence'), { readMilliseconds: () => elapsed });
    const configuration = resolveProviderProxyDeadlineConfiguration({ get: () => undefined });
    const holderAuthority = createControlHolderAuthority();
    const deadlines = createEnforcerDeadlineStateMachine(
      clock,
      configuration,
      { mintChallenge: () => randomUUID() },
      holderAuthority,
    );
    const bootstrapNonce = createBootstrapNonceCredential(NONCE);

    const endpoint = createControlEndpoint({
      socketPath,
      role: {
        heartbeatMethod: 'guardian.heartbeat.v1',
        methods: new Map<string, ControlMethod>([
          [
            'guardian.open.v1',
            {
              authority: 'establishes-control',
              handle: (params) => {
                bootstrapNonce.spend((params as { bootstrapNonce?: unknown } | null)?.bootstrapNonce);
                return { holder: holderFor('coordinator'), fields: {} };
              },
            },
          ],
        ]),
      },
      // The real machine, not a stub: this test exists because a stubbed one cannot show the wiring.
      challenges: deadlines,
      observer: { onControlLost: () => deadlines.observeEof() },
      timer,
      holderAuthority,
      requestTimeoutMs: 5_000,
    });
    await endpoint.listen();
    cleanups.push(() => endpoint.close());

    const before = deadlines.bounds();
    elapsed = 3_000n;

    const [opened, beat] = (await call(socketPath, [
      () => ({ method: 'guardian.open.v1', body: { bootstrapNonce: NONCE } }),
      (previous) => ({
        method: 'guardian.heartbeat.v1',
        body: {
          controlEpoch: (previous as { controlEpoch: number }).controlEpoch,
          heartbeatChallenge: (previous as { heartbeatChallenge: string }).heartbeatChallenge,
        },
      }),
    ])) as [{ heartbeatChallenge: string }, { state: string; nextHeartbeatChallenge: string }];

    expect(beat.state).toBe('active');
    expect(beat.nextHeartbeatChallenge).not.toBe(opened.heartbeatChallenge);

    // The point of the test: a healthy heartbeat moves the deadline the enforcement loop reads. Without
    // this wiring the enforcer reaps a live containment once the initial window elapses.
    const after = deadlines.bounds();
    expect(clock.compare(after.adoptionDeadline, before.adoptionDeadline)).toBe(1);
    expect(clock.compare(after.exitDeadline, before.exitDeadline)).toBe(1);
  });
});
