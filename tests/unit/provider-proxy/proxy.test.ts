import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createProxy, type SemanticOperationHost } from '#src/provider-proxy/proxy.js';
import type { ProviderOperationKey } from '#src/provider-proxy/ledger.js';
import type { ProxyBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';

/**
 * `proxy.ts`'s own control endpoint, driven over a real Unix socket with a fake `SemanticOperationHost` and a
 * fake `containment` (no real app-server child, no real guardian) — the same isolation
 * `operation-lifecycle.integration.test.ts` (another agent's concurrent territory, not touched here) already
 * uses for this exact module. This file exists separately, rather than adding to that one, only because that
 * file is off-limits for the duration of this fix.
 */

const timer: ControlEndpointTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

const NONCE = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'claude',
  binding: { provider: 'claude', kind: 'account', binding: {} },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'hi',
    cwd: '/tmp',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: {},
  protectedEnv: {},
  platform: 'linux',
};

function fakeHost(): SemanticOperationHost & { released: ProviderOperationKey[]; starts: number; stops: number } {
  const released: ProviderOperationKey[] = [];
  return {
    released,
    starts: 0,
    stops: 0,
    start() {
      this.starts += 1;
    },
    stop() {
      this.stops += 1;
    },
    releaseStaged(key) {
      released.push(key);
    },
  };
}

/** Records every `setTimeout` call the endpoint's own per-request budget timer makes, tagged with `ms`, while
 *  still actually scheduling it — so a request that is genuinely meant to time out still does. */
function recordingTimer(): { timer: ControlEndpointTimer; budgets: number[] } {
  const budgets: number[] = [];
  return {
    budgets,
    timer: {
      setTimeout: (callback: () => void, ms: number) => {
        budgets.push(ms);
        return setTimeout(callback, ms);
      },
      clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
    },
  };
}

type PreparedOperation = ProviderOperationKey & { proxyInstanceId: string; buildSetId: string };

async function startProxy(
  host: SemanticOperationHost,
  endpointTimer: ControlEndpointTimer = timer,
): Promise<{ control: ControlClient; operation: PreparedOperation }> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-proxy-test-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const endpoint = join(directory, 'p.sock');
  const buildSetId = randomUUID();
  const capsule: ProxyBootstrapCapsule = {
    role: 'proxy',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: NONCE,
    canonicalEndpoint: endpoint,
    guardianControlEndpoint: join(directory, 'g.sock'),
    proxyGuardianAuthSecret: 'c'.repeat(64),
  };
  const identity: ProxyIdentity = {
    proxyInstanceId: capsule.proxyInstanceId,
    pid: 6_000,
    processStartedAtSeconds: 800,
    processGroupId: 6_000,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalEndpoint: endpoint,
  };
  const clock = createMonotonicClock(Symbol('proxy-test'));
  let counter = 0;
  const proxy = createProxy({
    capsule,
    clock,
    identity,
    host,
    timer: endpointTimer,
    mintChallenge: () => `challenge-${(counter += 1)}`,
    mintReceipt: () => `receipt-${(counter += 1)}`,
    mintReservation: () => asReservation(randomUUID()),
    containment: {
      // No real guardian: a fixed root/receipt is all `operation.prepare.v1` needs to stage.
      stageProviderRoot: async () => ({
        providerRoot: { pid: 7_000, processStartedAtSeconds: 900 },
        receipt: asJointContainmentReceipt('joint-1'),
      }),
      confirmActivation: async () => {},
    },
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const control = await connectControlClient(endpoint, timer, 5_000);
  cleanups.push(() => control.close());
  const coordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 1,
    processStartedAtSeconds: 1,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId,
  };
  const opened = (await control.call(
    'control.open.v1',
    { bootstrapNonce: NONCE, coordinator: coordinatorIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  // Control is not "active" (able to call mutation methods) until the first heartbeat is echoed back.
  await control.call(
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  const operation = {
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: capsule.proxyInstanceId,
    buildSetId,
  };
  return { control, operation };
}

describe('provider-proxy proxy: staged-but-never-executed release (BLOCKING B4)', () => {
  it('releases a staged provider root when operation.cancel-pending.v1 cancels before activation', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);

    const prepared = (await control.call(
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepared: PREPARED },
      5_000,
    )) as { state: string; reservation: string };
    expect(prepared.state).toBe('pending-activation');

    const cancelled = await control.call(
      'operation.cancel-pending.v1',
      { operation, reservation: prepared.reservation },
      5_000,
    );

    expect(cancelled).toEqual({ state: 'released' });
    // The kernel was never started — `host.stop` must not have been reached for a cancel — but the staged
    // app-server session `operation.prepare.v1` opened must still have been released.
    expect(host.starts).toBe(0);
    expect(host.stops).toBe(0);
    expect(host.released).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
  });

  it('releases a staged provider root when operation.stop.v1 stops before activation', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);

    const prepared = (await control.call(
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepared: PREPARED },
      5_000,
    )) as { state: string };
    expect(prepared.state).toBe('pending-activation');

    const stopped = (await control.call('operation.stop.v1', { operation, cause: 'signal_abort' }, 5_000)) as {
      state: string;
    };

    expect(stopped.state).toBe('released');
    expect(host.starts).toBe(0);
    expect(host.stops).toBe(0);
    expect(host.released).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
  });

  it('does not release anything a second time — idempotent for a retried cancel', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);

    const prepared = (await control.call(
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepared: PREPARED },
      5_000,
    )) as { reservation: string };

    await control.call('operation.cancel-pending.v1', { operation, reservation: prepared.reservation }, 5_000);
    const repeated = await control.call(
      'operation.cancel-pending.v1',
      { operation, reservation: prepared.reservation },
      5_000,
    );

    expect(repeated).toEqual({ state: 'released' });
    // Released once, not once per call — the ledger entry was already gone on the retry, so the retry never
    // reaches the release call a second time.
    expect(host.released).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
  });
});

describe('provider-proxy proxy: operation.prepare.v1 budget (BLOCKING B5)', () => {
  it('never arms the endpoint’s own default per-request budget timer for operation.prepare.v1', async () => {
    const host = fakeHost();
    const recording = recordingTimer();
    const { control, operation } = await startProxy(host, recording.timer);

    // Sanity: `control.open.v1` and `control.heartbeat.v1` are both ordinary, no-declared-`budgetMs` calls
    // `startProxy` already made above, so the endpoint's default budget timer fires twice before this test
    // ever reaches `operation.prepare.v1` — proving the recorder is wired to the real mechanism that method
    // must not trip.
    const budgetsBeforePrepare = [...recording.budgets];
    expect(budgetsBeforePrepare).toEqual([PROXY_CONTROL_RPC_TIMEOUT_MS, PROXY_CONTROL_RPC_TIMEOUT_MS]);

    await control.call('operation.prepare.v1', { operation, hostFingerprint: FINGERPRINT, prepared: PREPARED }, 5_000);

    // Unchanged from before the call: `operation.prepare.v1` must declare `budgetMs: 'caller-deadline'` so
    // the endpoint's own timer never preempts a legitimately slow cold start with a "budget exceeded" failure
    // while the handler keeps running, abandoned, in the background.
    expect(recording.budgets).toEqual(budgetsBeforePrepare);
  });
});
