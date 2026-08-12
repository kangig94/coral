import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  carrierStatusOperationKey,
  observeCarrierStatuses,
  type CarrierStatusRecord,
} from '#src/coordinator/live/carrier-observer.js';
import { heartbeatOnce } from '#src/coordinator/live/provider-proxy/heartbeat.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import type { OperationStageHandle, SemanticOperationHost } from '#src/provider-proxy/operation-supervisor.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  jointContainmentReceiptSchema,
  operationIdentitySchema,
  proxyOperationStatusNonceSchema,
  reservationSchema,
  type OperationIdentity,
  type ProxyOperationStatusNonce,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const BOOTSTRAP_NONCE = 'a'.repeat(64);
const HOST_FINGERPRINT = 'b'.repeat(64);
const STATUS_NONCE = proxyOperationStatusNonceSchema.parse('cccccccc-cccc-cccc-cccc-cccccccccccc');

const timer: ControlEndpointTimer = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'carrier-status' } },
  request: {
    action: 'exec',
    sessionId: 'carrier-status-session',
    prompt: 'observe this operation',
    cwd: fixtureCanonicalWorkDir('/project'),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startStatusProxy(): Promise<
  Readonly<{
    controlEndpoint: string;
    held: OperationIdentity;
    missing: OperationIdentity;
    records: readonly CarrierStatusRecord[];
  }>
> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-carrier-status-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const controlEndpoint = join(directory, 'proxy.sock');
  const buildSetId = randomUUID();
  const proxyInstanceId = randomUUID();
  const guardianInstanceId = randomUUID();
  const reaperInstanceId = randomUUID();
  const coordinator = {
    instanceId: randomUUID(),
    pid: 4_000,
    processStartedAtSeconds: 700,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId,
  };
  const identity = {
    proxyInstanceId,
    pid: 6_000,
    processStartedAtSeconds: 850,
    processGroupId: 6_000,
    guardianInstanceId,
    reaperInstanceId,
    generation: coordinator.generation,
    flavor: coordinator.flavor,
    buildSetId,
    hostFingerprint: HOST_FINGERPRINT,
    canonicalEndpoint: controlEndpoint,
  };
  const clock = createMonotonicClock(Symbol('carrier-status-integration'), { readMilliseconds: () => 0n });
  const host: SemanticOperationHost = {
    start: () => {
      throw new Error('carrier status setup must not start a provider');
    },
    stop: async () => {},
  };
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      generation: coordinator.generation,
      flavor: coordinator.flavor,
      buildSetId,
      hostFingerprint: HOST_FINGERPRINT,
      guardianInstanceId,
      reaperInstanceId,
      proxyInstanceId,
      bootstrapNonce: BOOTSTRAP_NONCE,
      canonicalEndpoint: controlEndpoint,
      guardianControlEndpoint: join(directory, 'guardian.sock'),
      proxyGuardianAuthSecret: 'd'.repeat(64),
    },
    clock,
    identity,
    host,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => 'carrier-status-receipt',
    mintReservation: () => reservationSchema.parse(randomUUID()),
    wallClockNow: () => 0,
    containment: {
      stageProviderRoot: () => {
        const result: OperationStageHandle['result'] = Promise.resolve({
          state: 'staged',
          providerRoot: { pid: 7_001, processStartedAtSeconds: 900 },
          receipt: jointContainmentReceiptSchema.parse('carrier-status-containment'),
        });
        return {
          result,
          confirmActivation: async () => {},
          abortAndRelease: async () => {},
        };
      },
    },
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const control = await connectControlClient(controlEndpoint, timer, PROXY_CONTROL_RPC_TIMEOUT_MS);
  cleanups.push(() => control.close());
  const opened = (await control.call(
    'control.open.v1',
    { bootstrapNonce: BOOTSTRAP_NONCE, coordinator },
    PROXY_CONTROL_RPC_TIMEOUT_MS,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  await heartbeatOnce(control, 'control.heartbeat.v1', opened.controlEpoch, opened.heartbeatChallenge);

  const held = operationIdentitySchema.parse({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId,
    buildSetId,
  });
  const missing = operationIdentitySchema.parse({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId,
    buildSetId,
  });
  await control.call(
    'operation.prepare.v1',
    {
      operation: held,
      hostFingerprint: HOST_FINGERPRINT,
      prepareAttemptNumber: 1,
      prepared: PREPARED,
    },
    PROXY_CONTROL_RPC_TIMEOUT_MS,
  );
  expect(proxy.ledger().get(held), 'integration setup must create the live ledger row').not.toBeNull();

  const locator = {
    proxy: {
      instanceId: proxyInstanceId,
      pid: identity.pid,
      processStartedAtSeconds: identity.processStartedAtSeconds,
      controlEndpoint,
    },
  };
  return {
    controlEndpoint,
    held,
    missing,
    records: [
      { operation: held, locator },
      { operation: missing, locator },
    ],
  };
}

describe('carrier status observer wire seam', () => {
  it('observes held and absent only with an exact nonce echo through the real sender and endpoint', async () => {
    const set = await startStatusProxy();
    const mintNonce = vi.fn(() => STATUS_NONCE);

    const outcomes = await observeCarrierStatuses(set.records, {
      timer,
      mintNonce,
      log: vi.fn(),
    });

    expect(mintNonce).toHaveBeenCalledOnce();
    expect(outcomes).toEqual(
      new Map([
        [carrierStatusOperationKey(set.held), 'held'],
        [carrierStatusOperationKey(set.missing), 'absent'],
      ]),
    );
  });

  it('rejects a malformed nonce without converting either real operation result to absent', async () => {
    const set = await startStatusProxy();

    const outcomes = await observeCarrierStatuses(set.records, {
      timer,
      mintNonce: () => 'malformed-nonce' as ProxyOperationStatusNonce,
      log: vi.fn(),
    });

    expect([...outcomes.values()]).toEqual(['unknown', 'unknown']);
    expect([...outcomes.values()]).not.toContain('absent');

    const receiverProbe = await connectControlClient(set.controlEndpoint, timer, PROXY_CONTROL_RPC_TIMEOUT_MS);
    cleanups.push(() => receiverProbe.close());
    await expect(
      receiverProbe.call(
        'operation.status.v1',
        { operations: [set.held, set.missing], nonce: 'malformed-nonce' },
        PROXY_CONTROL_RPC_TIMEOUT_MS,
      ),
    ).rejects.toMatchObject({ protocolCode: 'protocol_violation' });
  });
});
