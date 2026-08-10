import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createProviderProxyAuthorityHeartbeatAssembly } from '#src/coordinator/live/provider-proxy/heartbeat.js';
import { establishRoleControl } from '#src/coordinator/live/provider-proxy/role-control.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { createBootstrapNonceCredential } from '#src/provider-proxy/bootstrap-capsule.js';
import { createControlEndpoint, type ControlMethod } from '#src/provider-proxy/control-endpoint.js';
import {
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_CONTROL_LEASE_MS,
  createEnforcerDeadlineStateMachine,
  providerProxyDeadlineConfigurationSchema,
  resolveProviderProxyDeadlineConfiguration,
  type ProviderProxyDeadlineConfiguration,
} from '#src/provider-proxy/orphan-deadline.js';
import { controlEpochSchema, heartbeatChallengeSchema } from '#src/provider-proxy/protocol.js';
import { runtimeControlTimer } from '#src/provider-proxy/role-spawn.js';
import type { Runtime } from '#src/runtime/ports.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

const NONCE = 'a'.repeat(64);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

type Frame = Readonly<{ method: string; body: unknown }>;

function releaseBarrier(barrier: (() => void) | null, label: string): void {
  if (barrier === null) throw new Error(`${label} was not reached`);
  barrier();
}

function releaseBarrierIfPresent(barrier: (() => void) | null): void {
  if (barrier !== null) barrier();
}

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

const predecessorOpenParamsSchema = z.object({ credential: z.literal('predecessor') }).strict();
const successorOpenParamsSchema = z.object({ credential: z.literal('successor') }).strict();
const evidenceOpenResultSchema = z
  .object({
    identity: z.enum(['predecessor', 'successor']),
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
  })
  .strict();

async function runSuccessorInitialHeartbeatSchedule(configuration: ProviderProxyDeadlineConfiguration) {
  const directory = mkdtempSync(join(tmpdir(), 'coral-successor-evidence-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'g.sock');
  let elapsed = 0n;
  const clock = createMonotonicClock(Symbol('successor-evidence'), { readMilliseconds: () => elapsed });
  const deadlines = createEnforcerDeadlineStateMachine(clock, configuration, {
    mintChallenge: () => randomUUID(),
  });
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'guardian.heartbeat.v1',
      methods: new Map<string, ControlMethod>([
        [
          'predecessor.open.v1',
          {
            authority: 'establishes-control',
            handle: (params) => {
              predecessorOpenParamsSchema.parse(params);
              return { holder: 'predecessor', fields: { identity: 'predecessor' } };
            },
          },
        ],
        [
          'successor.open.v1',
          {
            authority: 'establishes-control',
            handle: (params) => {
              successorOpenParamsSchema.parse(params);
              return { holder: 'successor', fields: { identity: 'successor' } };
            },
          },
        ],
      ]),
    },
    challenges: deadlines,
    observer: { onControlLost: () => deadlines.observeEof() },
    timer,
    requestTimeoutMs: 5_000,
  });
  await endpoint.listen();
  cleanups.push(() => endpoint.close());

  const clientTime = new VirtualTime();
  const controlTimer = runtimeControlTimer({ time: clientTime } as unknown as Runtime);
  const retry = {
    connectTimeoutMs: 2_000,
    retryIntervalMs: 20,
    overallDeadlineMs: 10_000,
    now: () => clientTime.now(),
    sleep: (ms: number) => clientTime.sleep(ms),
  };
  const clients: Parameters<typeof establishRoleControl>[0] = [];
  cleanups.push(() => {
    for (const client of clients) client.close();
  });
  const predecessor = await establishRoleControl(clients, controlTimer, retry, {
    role: 'guardian predecessor',
    endpoint: socketPath,
    openMethod: 'predecessor.open.v1',
    openParams: { credential: 'predecessor' },
    openParamsSchema: predecessorOpenParamsSchema,
    openResultSchema: evidenceOpenResultSchema,
    identity: (opened) => ({ identity: opened.identity }),
    heartbeatMethod: 'guardian.heartbeat.v1',
    expectedIdentity: { identity: 'predecessor' },
  });
  const acceptedEvidence = deadlines.bounds().lastRoundTripEvidenceAt;
  elapsed = BigInt(PROXY_CONTROL_LEASE_MS);

  const originalWrite = Socket.prototype.write;
  let holdOpenResponse = true;
  let holdHeartbeatRequest = true;
  let releaseOpenResponse: (() => void) | null = null;
  let releaseHeartbeatRequest: (() => void) | null = null;
  const writeSpy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
    this: Socket,
    ...args: Parameters<Socket['write']>
  ): boolean {
    const [chunk] = args;
    const frame = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const forward = (): boolean => Reflect.apply(originalWrite, this, args);
    if (holdOpenResponse && frame.includes('"identity":"successor"')) {
      holdOpenResponse = false;
      releaseOpenResponse = () => {
        forward();
      };
      return true;
    }
    if (holdHeartbeatRequest && frame.includes('"method":"guardian.heartbeat.v1"')) {
      holdHeartbeatRequest = false;
      releaseHeartbeatRequest = () => {
        forward();
      };
      return true;
    }
    return forward();
  });

  const successorPromise = establishRoleControl(clients, controlTimer, retry, {
    role: 'guardian successor',
    endpoint: socketPath,
    openMethod: 'successor.open.v1',
    openParams: { credential: 'successor' },
    openParamsSchema: successorOpenParamsSchema,
    openResultSchema: evidenceOpenResultSchema,
    identity: (opened) => ({ identity: opened.identity }),
    heartbeatMethod: 'guardian.heartbeat.v1',
    expectedIdentity: { identity: 'successor' },
  });
  void successorPromise.catch(() => undefined);
  try {
    await vi.waitFor(() => expect(releaseOpenResponse).not.toBeNull());
    elapsed += 4_900n;
    releaseBarrier(releaseOpenResponse, 'successor open response barrier');
    await vi.waitFor(() => expect(releaseHeartbeatRequest).not.toBeNull());
    elapsed += 4_900n;
    releaseBarrier(releaseHeartbeatRequest, 'successor heartbeat request barrier');
    const successor = await successorPromise.then(
      (session) => ({ accepted: true as const, session }),
      (error: unknown) => ({ accepted: false as const, error }),
    );
    return {
      acceptedEvidence,
      clock,
      deadlines,
      elapsed: Number(elapsed),
      predecessor,
      successor,
    };
  } finally {
    releaseBarrierIfPresent(releaseOpenResponse);
    releaseBarrierIfPresent(releaseHeartbeatRequest);
    writeSpy.mockRestore();
  }
}

describe('control heartbeats reach the deadline machine', () => {
  it('advances the enforcer deadlines on every accepted echo', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-evidence-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const socketPath = join(directory, 'g.sock');

    let elapsed = 0n;
    const clock = createMonotonicClock(Symbol('evidence'), { readMilliseconds: () => elapsed });
    const configuration = resolveProviderProxyDeadlineConfiguration({ get: () => undefined });
    const deadlines = createEnforcerDeadlineStateMachine(clock, configuration, {
      mintChallenge: () => randomUUID(),
    });
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
                return { holder: 'coordinator', fields: {} };
              },
            },
          ],
        ]),
      },
      // The real machine, not a stub: this test exists because a stubbed one cannot show the wiring.
      challenges: deadlines,
      observer: { onControlLost: () => deadlines.observeEof() },
      timer,
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

  it('refuses a second connection at accept time while control is live, leaving the deadlines where they were', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-evidence-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const socketPath = join(directory, 'g.sock');

    let elapsed = 0n;
    const clock = createMonotonicClock(Symbol('evidence-replay'), { readMilliseconds: () => elapsed });
    const deadlines = createEnforcerDeadlineStateMachine(
      clock,
      resolveProviderProxyDeadlineConfiguration({ get: () => undefined }),
      { mintChallenge: () => randomUUID() },
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
                return { holder: 'coordinator', fields: {} };
              },
            },
          ],
        ]),
      },
      challenges: deadlines,
      observer: { onControlLost: () => deadlines.observeEof() },
      timer,
      requestTimeoutMs: 5_000,
    });
    await endpoint.listen();
    cleanups.push(() => endpoint.close());

    const [opened] = (await call(socketPath, [
      () => ({ method: 'guardian.open.v1', body: { bootstrapNonce: NONCE } }),
      (previous) => ({
        method: 'guardian.heartbeat.v1',
        body: {
          controlEpoch: (previous as { controlEpoch: number }).controlEpoch,
          heartbeatChallenge: (previous as { heartbeatChallenge: string }).heartbeatChallenge,
        },
      }),
    ])) as [{ controlEpoch: number; heartbeatChallenge: string }];

    const afterFirst = deadlines.bounds();
    elapsed = 4_000n;

    // The replay is sent on a brand-new connection (`call` never reuses a socket across invocations), so it
    // is refused before the frame is ever read: control is still live on the first connection and this role
    // has no pairing slot, so `acceptConnection` destroys the second socket outright — observed here as the
    // client's own write failing, not a JSON-RPC error reply.
    await expect(
      call(socketPath, [
        () => ({
          method: 'guardian.heartbeat.v1',
          body: { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
        }),
      ]),
    ).rejects.toThrow(/EPIPE|ECONNRESET/u);

    // The refused socket never reached frame parsing, so nothing downstream of accept() could have run —
    // this checks that an accept-time refusal really is a no-op on deadline state, not that a challenge was
    // evaluated and found stale (`orphan-deadline.test.ts` already proves that at the unit level).
    expect(clock.compare(deadlines.bounds().adoptionDeadline, afterFirst.adoptionDeadline)).toBe(0);
  });
});

describe('successor control reaches the deadline machine through production establishment', () => {
  for (const orphanTimeoutMs of [
    DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
    MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  ]) {
    it(`accepts the successor initial heartbeat after both real call tails with O=${orphanTimeoutMs}`, async () => {
      const configuration = providerProxyDeadlineConfigurationSchema.parse({
        orphanTimeoutMs: String(orphanTimeoutMs),
      });
      const scheduled = await runSuccessorInitialHeartbeatSchedule(configuration);
      if (!scheduled.successor.accepted) throw scheduled.successor.error;
      const observedFaults: string[] = [];
      const faults = createProviderProxyAuthorityFaultLatch();
      faults.onFault((fault) => observedFaults.push(fault.kind));
      const heartbeatAssembly = createProviderProxyAuthorityHeartbeatAssembly(
        { time: new VirtualTime() } as unknown as Runtime,
        faults,
      );
      heartbeatAssembly.startRole('guardian', {
        client: scheduled.successor.session.client,
        controlEpoch: scheduled.successor.session.opened.controlEpoch,
        nextHeartbeatChallenge: scheduled.successor.session.nextHeartbeatChallenge,
        instanceId: 'successor',
      });

      expect({
        acceptedAt: scheduled.clock.millisecondsBetween(
          scheduled.acceptedEvidence,
          scheduled.deadlines.bounds().lastRoundTripEvidenceAt,
        ),
        elapsed: scheduled.elapsed,
        controlIsLive: scheduled.deadlines.controlIsLive(),
        state: scheduled.deadlines.state(),
        observedFaults,
      }).toEqual({
        acceptedAt: PROXY_CONTROL_LEASE_MS + 9_800,
        elapsed: PROXY_CONTROL_LEASE_MS + 9_800,
        controlIsLive: true,
        state: 'accepting-control',
        observedFaults: [],
      });
      heartbeatAssembly.stop();
    });
  }

  it('latches teardown before successor challenge handling at exact adoption for default and minimum policy', async () => {
    for (const orphanTimeoutMs of [
      DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
      MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'coral-successor-equality-'));
      cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
      const socketPath = join(directory, 'g.sock');
      let elapsed = 0n;
      const clock = createMonotonicClock(Symbol('successor-equality'), { readMilliseconds: () => elapsed });
      const configuration = providerProxyDeadlineConfigurationSchema.parse({
        orphanTimeoutMs: String(orphanTimeoutMs),
      });
      const deadlines = createEnforcerDeadlineStateMachine(clock, configuration, {
        mintChallenge: () => randomUUID(),
      });
      const endpoint = createControlEndpoint({
        socketPath,
        role: {
          heartbeatMethod: 'guardian.heartbeat.v1',
          methods: new Map<string, ControlMethod>([
            [
              'predecessor.open.v1',
              {
                authority: 'establishes-control',
                handle: () => ({ holder: 'predecessor', fields: {} }),
              },
            ],
            [
              'successor.open.v1',
              {
                authority: 'establishes-control',
                handle: () => ({ holder: 'successor', fields: {} }),
              },
            ],
          ]),
        },
        challenges: deadlines,
        observer: { onControlLost: () => deadlines.observeEof() },
        timer,
        requestTimeoutMs: 5_000,
      });
      await endpoint.listen();
      cleanups.push(() => endpoint.close());

      await call(socketPath, [
        () => ({ method: 'predecessor.open.v1', body: {} }),
        (previous) => ({
          method: 'guardian.heartbeat.v1',
          body: {
            controlEpoch: (previous as { controlEpoch: number }).controlEpoch,
            heartbeatChallenge: (previous as { heartbeatChallenge: string }).heartbeatChallenge,
          },
        }),
      ]);
      const acceptedEvidence = deadlines.bounds().lastRoundTripEvidenceAt;
      elapsed = BigInt(orphanTimeoutMs - configuration.teardownReserveMs);

      await expect(call(socketPath, [() => ({ method: 'successor.open.v1', body: {} })])).rejects.toThrow(
        'teardown-latched',
      );
      expect(clock.compare(deadlines.bounds().lastRoundTripEvidenceAt, acceptedEvidence)).toBe(0);
      expect(deadlines.state()).toBe('teardown-latched');
    }
  });

  it('keeps the predecessor-lease-omitting 35-second policy from reaching a late successor echo', async () => {
    const parsed = providerProxyDeadlineConfigurationSchema.safeParse({ orphanTimeoutMs: '35000' });
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'must satisfy the strict recurrence, process-bootstrap, and successor-adoption timing policy',
      );
      return;
    }

    const scheduled = await runSuccessorInitialHeartbeatSchedule(parsed.data);
    expect(
      scheduled.successor.accepted
        ? {
            accepted: true,
            acceptedAt: scheduled.clock.millisecondsBetween(
              scheduled.acceptedEvidence,
              scheduled.deadlines.bounds().lastRoundTripEvidenceAt,
            ),
          }
        : { accepted: false, error: String(scheduled.successor.error) },
    ).toEqual({ accepted: true, acceptedAt: PROXY_CONTROL_LEASE_MS + 9_800 });
  });
});
