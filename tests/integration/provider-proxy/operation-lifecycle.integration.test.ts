import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '#src/provider-proxy/ledger.js';
import { PROXY_CONTROL_LEASE_MS } from '#src/provider-proxy/orphan-deadline.js';
import { createProxy, type SemanticOperationHost } from '#src/provider-proxy/proxy.js';

const NONCE = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const GRANT_SECRET = 'f'.repeat(64);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

type Started = { jobId: string; operationId: string };

async function startProxy(options: { failStage?: boolean; failConfirmActivation?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coral-proxy-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const endpoint = join(directory, 'p.sock');

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
  const coordinator = {
    instanceId: randomUUID(),
    pid: 4_000,
    processStartedAtSeconds: 700,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
  };
  const identity = {
    proxyInstanceId: shared.proxyInstanceId,
    pid: 6_000,
    processStartedAtSeconds: 850,
    processGroupId: 6_000,
    guardianInstanceId: shared.guardianInstanceId,
    reaperInstanceId: shared.reaperInstanceId,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalEndpoint: endpoint,
  };

  let elapsed = 0n;
  const clock = createMonotonicClock(Symbol('proxy-lifecycle'), { readMilliseconds: () => elapsed });
  const started: Array<Started & { prepared: unknown }> = [];
  const stopped: Array<Started & { cause: string }> = [];
  const host: SemanticOperationHost = {
    // Recording `prepared` (not just `key`) is what exposes a host that starts with the wrong payload: the
    // proxy must hand over the envelope prepare validated, not activate's own request params.
    start: ({ key, prepared }) => {
      started.push({ ...key, prepared });
    },
    stop: ({ key, cause }) => {
      stopped.push({ ...key, cause });
    },
  };

  let receipts = 0;
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      ...shared,
      canonicalEndpoint: endpoint,
      guardianControlEndpoint: join(directory, 'g.sock'),
      proxyGuardianAuthSecret: 'c'.repeat(64),
    },
    clock,
    identity,
    host,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => {
      receipts += 1;
      return `receipt-${receipts}`;
    },
    mintReservationId: () => randomUUID(),
    mintActivationNonce: () => randomUUID(),
    containment: {
      stageProviderRoot: () => {
        if (options.failStage === true) throw new Error('the guardian refused to stage this root');
        return Promise.resolve({ providerRoot: { pid: 7_001, processStartedAtSeconds: 800 }, receipt: 'joint-1' });
      },
      confirmActivation: () => {
        if (options.failConfirmActivation === true) {
          throw new Error('the guardian did not recognise this activation pair');
        }
        return Promise.resolve();
      },
    },
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const control = await connectControlClient(endpoint, timer, 5_000);
  cleanups.push(() => control.close());
  const opened = (await control.call('control.open.v1', { bootstrapNonce: NONCE, coordinator }, 5_000)) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  await control.call(
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  const operationFor = () => ({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: shared.proxyInstanceId,
    buildSetId: shared.buildSetId,
  });

  const advance = (ms: number): void => {
    elapsed += BigInt(ms);
  };

  return { proxy, control, endpoint, shared, coordinator, identity, operationFor, started, stopped, advance };
}

type ProxyUnderTest = Awaited<ReturnType<typeof startProxy>>;

async function prepare(
  set: ProxyUnderTest,
  operation = set.operationFor(),
): Promise<{ operation: ReturnType<ProxyUnderTest['operationFor']>; reserved: Record<string, string> }> {
  const reserved = (await set.control.call(
    'operation.prepare.v1',
    { operation, hostFingerprint: FINGERPRINT, prepared: { kind: 'app-server', turns: [] } },
    5_000,
  )) as Record<string, string>;
  return { operation, reserved };
}

async function activate(set: ProxyUnderTest, operation: unknown, reserved: Record<string, string>): Promise<unknown> {
  return set.control.call(
    'operation.activate.v1',
    {
      operation,
      reservationId: reserved.reservationId,
      activationNonce: reserved.activationNonce,
      jointContainmentReceipt: reserved.jointContainmentReceipt,
      jointActivationReceipt: 'joint-activation-1',
    },
    5_000,
  );
}

async function installGrant(set: ProxyUnderTest, operationIds: readonly string[]): Promise<Record<string, unknown>> {
  const grantId = randomUUID();
  const operations = [...operationIds].sort().map((operationId) => ({
    operation: {
      jobId: randomUUID(),
      operationId,
      proxyInstanceId: set.shared.proxyInstanceId,
      buildSetId: set.shared.buildSetId,
    },
    carrierState: 'executing' as const,
    committedThroughProviderSeq: 3,
  }));
  const set_ = {
    grantId,
    generation: set.shared.generation,
    hostFingerprint: FINGERPRINT,
    buildSetId: set.shared.buildSetId,
    proxyInstanceId: set.shared.proxyInstanceId,
    operations,
  };
  await set.control.call(
    'handoff.install.v1',
    {
      ...set_,
      secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
      orphanTimeoutMs: 30_000,
    },
    5_000,
  );
  // A redeemer never names the timeout: it is bound where it is installed, so the redeem request is the
  // set tuple plus the credential and nothing else.
  return { ...set_, secret: GRANT_SECRET, successor: set.coordinator };
}

describe('provider-proxy operation lifecycle', () => {
  it('reserves, stages the root with both authorities, and starts the kernel exactly once', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    expect(reserved.state).toBe('pending-activation');
    expect(reserved.jointContainmentReceipt).toBe('joint-1');
    expect(reserved.providerRoot).toEqual({ pid: 7_001, processStartedAtSeconds: 800 });
    // Staging precedes the reservation being reported, so a reservation the coordinator goes on to commit
    // always names a root the containment can already reach.
    expect(set.started).toEqual([]);

    expect(await activate(set, operation, reserved)).toEqual({ state: 'executing', committedThroughProviderSeq: 0 });
    // The host must receive the envelope prepare validated, not activate's own request params.
    expect(set.started).toEqual([
      { jobId: operation.jobId, operationId: operation.operationId, prepared: { kind: 'app-server', turns: [] } },
    ]);
  });

  it('treats a repeated activation as the same request, not a second kernel', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);

    expect(await activate(set, operation, reserved)).toEqual({ state: 'executing', committedThroughProviderSeq: 0 });

    // Starting a second kernel would fork the carrier this proxy exists to own.
    expect(set.started).toHaveLength(1);
  });

  it('refuses activation that presents a containment receipt nobody staged, and starts no kernel', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    await expect(activate(set, operation, { ...reserved, jointContainmentReceipt: 'forged-receipt' })).rejects.toThrow(
      /different containment receipt/u,
    );
    expect(set.started).toEqual([]);
  });

  it('refuses activation the guardian does not confirm, and starts no kernel', async () => {
    const set = await startProxy({ failConfirmActivation: true });
    const { operation, reserved } = await prepare(set);

    await expect(activate(set, operation, reserved)).rejects.toThrow(/did not recognise/u);
    expect(set.started).toEqual([]);
  });

  it('refuses a prepare naming a different host fingerprint', async () => {
    const set = await startProxy();

    await expect(
      set.control.call(
        'operation.prepare.v1',
        { operation: set.operationFor(), hostFingerprint: 'c'.repeat(64), prepared: {} },
        5_000,
      ),
    ).rejects.toThrow(/different host fingerprint/u);
  });

  it('answers capacity exhaustion as a typed retryable state rather than an error', async () => {
    const set = await startProxy();
    for (let index = 0; index < MAX_PROXY_OPERATION_LEDGERS; index += 1) {
      await prepare(set);
    }

    const { reserved } = await prepare(set);

    // Admission stays with the coordinator: the proxy reports it cannot take the work instead of queueing
    // it, and writes nothing it would then have to unwind.
    expect(reserved).toEqual({ state: 'capacity', retryable: true, reason: 'operation-ledgers' });
  });

  it('moves an expired reservation to a state control can still cancel', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    set.advance(15_001);

    await expect(activate(set, operation, reserved)).rejects.toThrow(/lease expired/u);

    // The reservation is not silently gone: durable meta may already name it, so it stays cancellable by
    // exactly the reservation that was authorized.
    expect(
      await set.control.call(
        'operation.cancel-pending.v1',
        { operation, reservationId: reserved.reservationId, activationNonce: reserved.activationNonce },
        5_000,
      ),
    ).toEqual({ state: 'released' });
  });

  it('renews a pending-activation reservation, extending its lease from the call’s own now', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    set.advance(1_000);

    const renewed = (await set.control.call(
      'operation.renew-activation.v1',
      { operation, reservationId: reserved.reservationId, activationNonce: reserved.activationNonce },
      5_000,
    )) as { state: string; leaseExpiresInMs: number };

    expect(renewed.state).toBe('pending-activation');
    // Renewed from *this* call's own now, not the original prepare's, so the fresh budget is the same full
    // lease again rather than the original lease minus the second that already elapsed.
    expect(renewed.leaseExpiresInMs).toBe(reserved.leaseExpiresInMs);

    // The renewed lease actually took effect: activating well past the original (unrenewed) deadline still
    // succeeds rather than being refused as expired.
    set.advance(14_500);
    expect(await activate(set, operation, reserved)).toMatchObject({ state: 'executing' });
  });

  it('refuses operation.renew-activation.v1 presenting a different reservation for a known operation', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    await expect(
      set.control.call(
        'operation.renew-activation.v1',
        { operation, reservationId: randomUUID(), activationNonce: reserved.activationNonce },
        5_000,
      ),
    ).rejects.toThrow(/different reservation/u);
  });

  it('reports a repeated cancel as released rather than not-found', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    const request = {
      operation,
      reservationId: reserved.reservationId,
      activationNonce: reserved.activationNonce,
    };
    await set.control.call('operation.cancel-pending.v1', request, 5_000);

    expect(await set.control.call('operation.cancel-pending.v1', request, 5_000)).toEqual({ state: 'released' });
  });

  it('refuses a cancel presenting a different reservation', async () => {
    const set = await startProxy();
    const { operation } = await prepare(set);

    await expect(
      set.control.call(
        'operation.cancel-pending.v1',
        { operation, reservationId: randomUUID(), activationNonce: randomUUID() },
        5_000,
      ),
    ).rejects.toThrow(/different reservation/u);
  });

  it.each([
    ['restart', 'suspended-awaiting-durable-decision'],
    ['handoff', 'suspended-awaiting-durable-decision'],
    ['user_abort', 'terminal-awaiting-journal-ack'],
    ['signal_abort', 'terminal-awaiting-journal-ack'],
    ['queue_shutdown', 'terminal-awaiting-journal-ack'],
  ])('stops on %s into %s, awaiting the coordinator’s durable decision', async (cause, expected) => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);

    const stopped = (await set.control.call('operation.stop.v1', { operation, cause }, 5_000)) as { state: string };

    // Only a recorded restart or handoff suspends. Claiming the abort causes interrupted the operation
    // would write an interruption the user never suffered.
    expect(stopped.state).toBe(expected);
    expect(set.stopped).toEqual([{ jobId: operation.jobId, operationId: operation.operationId, cause }]);
  });

  it('releases a pending-activation entry on stop without calling a kernel that never started', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    const stopped = (await set.control.call('operation.stop.v1', { operation, cause: 'user_abort' }, 5_000)) as {
      state: string;
    };

    // `SemanticOperationHost.stop`'s contract is "stops a running kernel" — this one was never started.
    expect(stopped.state).toBe('released');
    expect(set.stopped).toEqual([]);
    // Released, not stuck: a cancel for the same reservation now reports it as already gone.
    expect(
      await set.control.call(
        'operation.cancel-pending.v1',
        { operation, reservationId: reserved.reservationId, activationNonce: reserved.activationNonce },
        5_000,
      ),
    ).toEqual({ state: 'released' });
  });

  it('refuses adoption before any grant has been redeemed on this proxy', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);

    await expect(
      set.control.call('operation.adopt.v1', { operation, committedThroughProviderSeq: 0 }, 5_000),
    ).rejects.toThrow(/No grant has been redeemed/u);
  });

  it('adopts only operations inside the redeemed set', async () => {
    const set = await startProxy();
    const inside = await prepare(set);
    const outside = await prepare(set);
    await activate(set, inside.operation, inside.reserved);
    await activate(set, outside.operation, outside.reserved);
    const redeem = await installGrant(set, [inside.operation.operationId]);
    set.control.close();
    set.advance(5_001);

    const successor = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await successor.call('handoff.redeem.v1', redeem, 5_000)) as {
      state: string;
      operations: string[];
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    expect(redeemed.state).toBe('redeemed-provisional');
    await successor.call(
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );

    expect(
      await successor.call(
        'operation.adopt.v1',
        { operation: inside.operation, committedThroughProviderSeq: 0 },
        5_000,
      ),
    ).toEqual({ state: 'executing', replayFromProviderSeq: 1 });
    // An otherwise valid, executing operation outside the redeemed set is one this successor never earned,
    // however good its control tenancy is.
    await expect(
      successor.call('operation.adopt.v1', { operation: outside.operation, committedThroughProviderSeq: 0 }, 5_000),
    ).rejects.toThrow(/outside the redeemed set/u);
  });

  it('refuses a grant installed against another proxy instance', async () => {
    const set = await startProxy();

    await expect(
      set.control.call(
        'handoff.install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          generation: set.shared.generation,
          hostFingerprint: FINGERPRINT,
          buildSetId: set.shared.buildSetId,
          proxyInstanceId: randomUUID(),
          operations: [],
          orphanTimeoutMs: 30_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/not this proxy/u);
  });

  it('refuses an unsorted or duplicated operation set at handoff.install.v1 ingress', async () => {
    const set = await startProxy();
    const opA = set.operationFor();
    const opB = set.operationFor();
    // Deliberately descending: whichever of the two sorts later goes first.
    const [first, second] = opA.operationId < opB.operationId ? [opB, opA] : [opA, opB];
    const entry = (operation: ReturnType<typeof set.operationFor>) => ({
      operation,
      carrierState: 'executing' as const,
      committedThroughProviderSeq: 0,
    });
    const install = (operations: ReturnType<typeof entry>[]): Promise<unknown> =>
      set.control.call(
        'handoff.install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          generation: set.shared.generation,
          hostFingerprint: FINGERPRINT,
          buildSetId: set.shared.buildSetId,
          proxyInstanceId: set.shared.proxyInstanceId,
          operations,
          orphanTimeoutMs: 30_000,
        },
        5_000,
      );

    // Only the capsule's own copy of this schema used to carry the byte-sort refinement; the wire schema
    // this method actually parses did not, so an unsorted set installed here and a sorted redemption later
    // disagreed without either looking malformed.
    await expect(install([entry(first), entry(second)])).rejects.toMatchObject({ protocolCode: 'protocol_violation' });
    // Duplicated is refused for the same reason, not merely unsorted.
    await expect(install([entry(first), entry(first)])).rejects.toMatchObject({ protocolCode: 'protocol_violation' });
  });

  it("keeps a redeemed successor's first challenge answerable for the full lease, unclamped by any ceiling", async () => {
    const set = await startProxy();
    // A grant that names no operations is enough: only the tenancy this redemption opens is under test.
    const redeem = await installGrant(set, []);
    set.control.close();
    set.advance(5_001);

    const successor = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await successor.call('handoff.redeem.v1', redeem, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };

    // Right up to — but not reaching — the bare lease boundary measured from redemption itself: operational
    // control carries no adoption-style ceiling to clamp this any earlier, unlike the enforcer's own first
    // challenge (see orphan-deadline.test.ts's "caps the first challenge at the adoption deadline").
    set.advance(PROXY_CONTROL_LEASE_MS - 1);
    const stillLive = (await successor.call(
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    )) as { state: string };
    expect(stillLive.state).toBe('active');
  });
});
