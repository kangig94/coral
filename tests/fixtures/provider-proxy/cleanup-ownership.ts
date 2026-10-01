import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { createProxyGuardianContainment } from '#src/provider-proxy/role-main.js';
import type { ProxyIdentity, ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import { controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { asJointActivationReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const identity: ProxyIdentity = {
  proxyInstanceId: randomUUID(),
  pid: 202,
  incarnation: testIncarnation(202),
  processGroupId: 202,
  guardianInstanceId: randomUUID(),
  reaperInstanceId: randomUUID(),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: randomUUID(),
  hostFingerprint: 'a'.repeat(64),
  canonicalEndpoint: '/tmp/unused.sock',
};
const prepared: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'test' } },
  request: {
    action: 'exec',
    sessionId: 'test',
    prompt: 'test',
    cwd: fixtureCanonicalWorkDir('/project'),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: {},
  protectedEnv: {},
  platform: 'linux',
};
let refusing = true;
let startReleases = 0;
let stageReleases = 0;
let membershipReleases = 0;
let releaseRegistration: () => void = () => {};
const registration = process.argv.includes('--pending-registration')
  ? new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    })
  : Promise.resolve();
const containment = createProxyGuardianContainment({
  identity,
  guardianChannel: {
    exchange: async (method) => {
      if (method === 'guardian.register-provider-root.v1') {
        await registration;
        return controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'result',
            value: {
              state: 'staged-contained',
              providerRoot: { pid: 303, incarnation: testIncarnation(303) },
              jointContainmentReceipt: 'receipt',
            },
          },
        });
      }
      membershipReleases++;
      return controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'membership-released' } },
      });
    },
  },
  stageProviderRoot: () => ({
    result: Promise.resolve({
      state: 'staged',
      providerRoot: { pid: 303, incarnation: testIncarnation(303) },
      receipt: 'unused' as never,
    }),
    confirmActivation: async () => {},
    abortAndRelease: async () => {
      stageReleases++;
      if (refusing) throw new Error('stage release refused');
    },
  }),
});
if (process.argv.includes('--pending-registration')) {
  const handle = containment.stageProviderRoot(
    { jobId: randomUUID(), operationId: randomUUID() },
    { prepared, reservation: asReservation(randomUUID()) },
  );
  const release = handle.abortAndRelease().then(
    () => 'released',
    () => 'refused',
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(membershipReleases, 0);
  releaseRegistration();
  assert.equal(await release, 'refused');
} else {
  const supervisor = new OperationSupervisor({
    host: {
      start: () => ({
        result: Promise.resolve({
          kind: 'started',
          hostRef: {
            provider: 'codex',
            fingerprint: identity.hostFingerprint,
            instanceId: 'shared',
            leaseMode: 'shared',
          },
        }),
        abortAndRelease: async () => {
          startReleases++;
          if (refusing) throw new Error('start release refused');
        },
      }),
      stop: async () => {},
    },
    timer: { setTimeout: () => ({}), clearTimeout: () => {} },
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => 0,
    nowMs: () => 0,
    proxyInstanceId: identity.proxyInstanceId,
    buildSetId: identity.buildSetId,
    stageProviderRoot: containment.stageProviderRoot,
    pushProviderEvent: () => ({
      controlEpoch: 1,
      response: Promise.resolve({ kind: 'ack', committedThroughProviderSeq: 0 }),
    }),
    faultProviderEventControl: () => {},
  });
  const operations = Array.from({ length: 2 }, () => ({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: identity.proxyInstanceId,
    buildSetId: identity.buildSetId,
  }));
  for (const operation of operations) {
    await supervisor.prepare(operation, { prepareAttemptNumber: 1, prepareAttemptKey: 'b'.repeat(64), prepared });
    const entry = supervisor.ledger().get(operation)!;
    await supervisor.activate(operation, {
      reservation: entry.reservation,
      jointContainmentReceipt: entry.jointContainmentReceipt!,
      jointActivationReceipt: asJointActivationReceipt('activation'),
      activationFingerprint: 'c'.repeat(64),
    });
    supervisor.ledger().transition(operation, 'executing');
  }
  supervisor.ledger().transition(operations[0], 'terminal-awaiting-settlement');
  await assert.rejects(supervisor.settle(operations[0], 0), /start release refused/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(supervisor.ledger().get(operations[1])?.state, 'executing');
  assert.equal(membershipReleases, 0);
  refusing = false;
  assert.deepEqual(await supervisor.settle(operations[0], 0), {
    state: 'released-after-terminal',
    settledThroughProviderSeq: 0,
  });
  assert.equal(startReleases, 2);
  assert.equal(stageReleases, 2);
  assert.equal(membershipReleases, 1);
  assert.equal(supervisor.ledger().get(operations[1])?.state, 'executing');
}
console.log('cleanup owned; sibling survives');
