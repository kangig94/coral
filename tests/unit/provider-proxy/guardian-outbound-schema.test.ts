import type * as MockedNodeNetModule from 'node:net';
import { strictControlExchangeResult } from '#tests/support/control-exchange.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';

import type { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import {
  controlExchangeForTest,
  type ControlClient,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import type { EnforcementScheduler } from '#src/provider-proxy/enforcement.js';
import { createGuardian } from '#src/provider-proxy/guardian.js';
import { createControlHolderAuthority, type ControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import type { EnforcerDeadlineStateMachine } from '#src/provider-proxy/orphan-deadline.js';
import { type enforcementHoldStatusSchema } from '#src/provider-proxy/protocol.js';

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof MockedNodeNetModule>();
  const { EventEmitter } = await import('node:events');
  const listeners = new Map<string, (socket: MemorySocket) => void>();
  class MemorySocket extends EventEmitter {
    destroyed = false;
    peer!: MemorySocket;
    write(data: string, done?: () => void): boolean {
      done?.();
      setImmediate(() => {
        if (!this.peer.destroyed) this.peer.emit('data', Buffer.from(data));
      });
      return true;
    }
    destroy(): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
      this.peer.destroy();
      return this;
    }
    end(data?: string, done?: () => void): this {
      if (data !== undefined) this.write(data);
      setImmediate(() => {
        done?.();
        this.destroy();
      });
      return this;
    }
  }
  return {
    ...actual,
    createServer: (accept: (socket: MemorySocket) => void) => {
      const server = new EventEmitter();
      let path = '';
      return Object.assign(server, {
        listen: (socketPath: string) => {
          path = socketPath;
          listeners.set(path, accept);
          queueMicrotask(() => server.emit('listening'));
        },
        close: (done: () => void) => {
          listeners.delete(path);
          done();
        },
      });
    },
    createConnection: (path: string) => {
      const client = new MemorySocket();
      const server = new MemorySocket();
      client.peer = server;
      server.peer = client;
      queueMicrotask(() => {
        const accept = listeners.get(path);
        if (accept === undefined) throw new Error(`No in-memory endpoint at ${path}`);
        accept(server);
        client.emit('connect');
      });
      return client;
    },
  };
});

const NONCE = 'a'.repeat(64);
const PAIR_SECRET = 'c'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const CONTAINMENT = {
  pid: 5_100,
  incarnation: testIncarnation(900),
  processGroupId: 5_100,
  containmentKind: 'posix-group',
};
const ROOT = { pid: 6_001, incarnation: testIncarnation(800) };
const idleScheduler: EnforcementScheduler = { schedule: () => ({}), cancel: () => {} };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function deadlinesFor<Scope extends symbol>(clock: MonotonicClock<Scope>): EnforcerDeadlineStateMachine<Scope> {
  return {
    orphanTimeoutMs: () => 30_000,
    controlIsLive: () => true,
    issueFirstChallenge: () => ({ accepted: true, challenge: 'challenge' }) as const,
    admitSuccessor: () => ({ accepted: true, challenge: 'challenge' }) as const,
    reattachControl: () => ({ accepted: true }) as const,
    echoChallenge: () => ({ accepted: true, nextChallenge: 'next-challenge' }) as const,
    observeEof: () => {},
    observePairingLoss: () => {},
    latchTeardown: () => {},
    markContainmentAbsent: () => {},
    markExited: () => {},
    renewHolderCheck: () => {},
    bounds: () => ({
      lastRoundTripEvidenceAt: clock.now(),
      eofAt: null,
      controlLossAt: clock.now(),
      adoptionDeadline: clock.shiftMilliseconds(clock.now(), 60_000),
      exitDeadline: clock.shiftMilliseconds(clock.now(), 74_000),
      holderCheckAt: clock.shiftMilliseconds(clock.now(), 60_000),
      holderCheckAccelerated: false,
    }),
    state: () => 'accepting-control' as const,
  };
}

type GuardianHarness = Awaited<ReturnType<typeof createGuardianHarness>>;

async function createGuardianHarness(
  holderAuthority: ControlHolderAuthority = createControlHolderAuthority(),
  containmentFailure?: Readonly<{ latchTeardown: () => void; observeLiveness: () => never }>,
  enforcementHoldStatus?: () => z.infer<typeof enforcementHoldStatusSchema> | null,
  abandonUnattributable: () => boolean = () => false,
) {
  const clock = createMonotonicClock(Symbol('guardian-outbound'), { readMilliseconds: () => 0n });
  const shared = {
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: randomUUID(),
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: NONCE,
  };
  const coordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 4_000,
    incarnation: testIncarnation(700),
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
  };
  const proxyIdentity = {
    proxyInstanceId: shared.proxyInstanceId,
    pid: 6_000,
    incarnation: testIncarnation(850),
    processGroupId: CONTAINMENT.processGroupId,
    guardianInstanceId: shared.guardianInstanceId,
    reaperInstanceId: shared.reaperInstanceId,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalEndpoint: '/proxy.sock',
  };
  const reaperIdentity = {
    reaperInstanceId: shared.reaperInstanceId,
    pid: 5_101,
    incarnation: testIncarnation(901),
    guardianInstanceId: shared.guardianInstanceId,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalControlEndpoint: '/reaper.sock',
    containmentKind: CONTAINMENT.containmentKind,
  };
  const reaperExchange = vi.fn(async (method: string): Promise<ControlExchange> => {
    let value: unknown;
    if (method === 'reaper.record-containment.v1') {
      value = { state: 'containment-recorded', reaper: reaperIdentity };
    } else if (method === 'reaper.record-redemption.v1') {
      value = { state: 'redemption-recorded' };
    } else if (method === 'reaper.acquisition-publish.v1') {
      value = { state: 'acquisition-published' };
    } else if (method === 'reaper.containment-prepare.v1') {
      value = { state: 'containment-prepared', token: 'prepare-token', providerRoots: [] };
    } else {
      value = { state: 'root-recorded' };
    }
    return controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } });
  });
  const reaperChannel: ControlClient = {
    exchange: reaperExchange,
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: vi.fn(),
  };
  let receipt = 0;
  const mintReceipt = vi.fn(() => {
    receipt += 1;
    return `receipt-${receipt}`;
  });
  const guardian = createGuardian({
    capsule: {
      role: 'guardian',
      ...shared,
      canonicalControlEndpoint: '/guardian.sock',
      reaperControlEndpoint: '/reaper.sock',
      proxyEndpoint: '/proxy.sock',
      guardianReaperAuthSecret: PAIR_SECRET,
      proxyGuardianAuthSecret: PAIR_SECRET,
    },
    clock,
    deadlines: {
      ...deadlinesFor(clock),
      ...(containmentFailure === undefined ? {} : { latchTeardown: containmentFailure.latchTeardown }),
    },
    containmentEnvironment: {
      clock,
      process: {
        kill: () => true,
        observeLiveness: containmentFailure?.observeLiveness ?? (() => 'alive' as const),
        observeRecordedProcessAsync: async () => {
          if (containmentFailure === undefined) return 'alive';
          return containmentFailure.observeLiveness();
        },
      },
      platform: 'linux',
      maxRecordedRoots: 128,
      readProcessIncarnation: () => CONTAINMENT.incarnation,
    },
    scheduler: idleScheduler,
    timer: {
      setTimeout: () => ({}),
      clearTimeout: () => {},
    },
    mintReceipt,
    reaperChannel,
    self: { pid: 5_102, incarnation: testIncarnation(902) },
    reaperSelf: { pid: reaperIdentity.pid, incarnation: reaperIdentity.incarnation },
    holderAuthority,
    observeHolder: () => Promise.resolve('unknown' as const),
    ...(enforcementHoldStatus === undefined ? {} : { enforcementHoldStatus }),
    abandonUnattributable,
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  cleanups.push(() => guardian.close());

  await guardian.listen();
  await guardian.recordContainment(CONTAINMENT);
  const timer = { setTimeout: () => ({}), clearTimeout: () => {} };
  const control = await connectControlClient('/guardian.sock', timer, 1000);
  const pairing = await connectControlClient('/guardian.sock', timer, 1000);
  cleanups.push(async () => {
    control.close();
    pairing.close();
  });
  await strictControlExchangeResult(pairing, 'guardian.pair.v1', { pairingSecret: PAIR_SECRET }, 1000);
  const opening = (await strictControlExchangeResult(
    control,
    'guardian.open.v1',
    {
      bootstrapNonce: NONCE,
      coordinator: coordinatorIdentity,
      proxy: proxyIdentity,
    },
    1000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  await strictControlExchangeResult(
    control,
    'guardian.heartbeat.v1',
    { controlEpoch: opening.controlEpoch, heartbeatChallenge: opening.heartbeatChallenge },
    1000,
  );
  const call = (name: string, params: unknown) =>
    strictControlExchangeResult(name === 'guardian.register-provider-root.v1' ? pairing : control, name, params, 1000);
  reaperExchange.mockClear();
  const operation = () => ({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: shared.proxyInstanceId,
    buildSetId: shared.buildSetId,
  });

  const guardianIdentity = {
    guardianInstanceId: shared.guardianInstanceId,
    pid: 5_102,
    incarnation: testIncarnation(902),
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalControlEndpoint: '/guardian.sock',
  };

  return {
    guardian,
    call,
    reaperExchange,
    mintReceipt,
    coordinatorIdentity,
    guardianIdentity,
    reaperIdentity,
    proxyIdentity,
    abandonUnattributable,
    operation,
    holderAuthority,
  };
}

async function armGuardian(harness: GuardianHarness): Promise<void> {
  await harness.guardian.recordContainment(CONTAINMENT);
  harness.reaperExchange.mockClear();
}

describe('guardian outbound schemas', () => {
  it('does not latch activation after active control changes during reaper confirmation', async () => {
    const harness = await createGuardianHarness();
    await armGuardian(harness);
    const operation = harness.operation();
    const reservation = randomUUID();
    const staged = (await harness.call('guardian.register-provider-root.v1', {
      proxy: harness.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerIncarnation: ROOT.incarnation,
    })) as { jointContainmentReceipt: string };
    const activation = {
      operation,
      reservation,
      providerRoot: ROOT,
      jointContainmentReceipt: staged.jointContainmentReceipt,
    };
    harness.mintReceipt.mockClear();
    harness.reaperExchange.mockImplementationOnce(async () => {
      harness.holderAuthority.install({
        controlEpoch: 2,
        holder: { instanceId: randomUUID(), pid: 4001, incarnation: testIncarnation(4001) },
      });
      return controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'root-recorded' } },
      });
    });

    await expect(harness.call('guardian.operation-activate.v1', activation)).rejects.toMatchObject({
      remoteFailure: { protocolCode: 'unauthorized_control' },
    });
    expect(harness.mintReceipt).not.toHaveBeenCalled();
  });
});
