import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppServerProxyRouteRequest } from '#src/jobs/contracts/app-server-proxy-route.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  unexercisedControllerSuccessionControls,
  unexercisedProviderHostControls,
} from '#tests/helpers/provider-host-controls.js';

const TEST_WORKSPACE = mkdtempSync(join(tmpdir(), 'coral-provider-proxy-launch-route-'));

afterAll(() => rmSync(TEST_WORKSPACE, { recursive: true, force: true }));

const request: AppServerProxyRouteRequest = {
  jobId: randomUUID(),
  operationId: randomUUID(),
  jobLaunchEventSeq: 41,
  sessionId: randomUUID(),
  sessionVersion: 3,
  hostSpec: {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir(TEST_WORKSPACE),
    leaseMode: 'job-exclusive',
  },
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: fixtureCanonicalWorkDir(TEST_WORKSPACE),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
  childAuthorization: {
    principalWire: {
      subject: 'agent',
      binding: { kind: 'project', root: fixtureCanonicalWorkDir(TEST_WORKSPACE) },
      attenuatedCaps: ['liveness', 'jobs:read'],
    },
    namespace: 'tests',
    expiresAtMs: 60_000,
  },
};

function authority(): DurableProviderProxyOperationAuthority {
  const proxyInstanceId = randomUUID();
  const buildSetId = randomUUID();
  return {
    proxyInstanceId,
    providerHosts: unexercisedProviderHostControls,
    ...unexercisedControllerSuccessionControls,
    faulted: new Promise<never>(() => {}),
    autonomousDeadline: {
      orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
      adoptionWindowMs: Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Math.floor(Number.MAX_SAFE_INTEGER / 4),
      },
    },
    onFault: () => () => undefined,
    onIncident: () => () => undefined,
    redeemControl: () => new Promise<never>(() => undefined),
    promoteControl: async () => {
      throw new Error('unused');
    },
    setIdentity: {
      buildSetId,
      hostFingerprint: 'a'.repeat(64),
      guardianInstanceId: randomUUID(),
      guardianPid: 100,
      guardianIncarnation: testIncarnation(1),
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId,
      proxyPid: 200,
      reaperInstanceId: randomUUID(),
      reaperPid: 300,
      reaperIncarnation: testIncarnation(2),
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'detached-group',
      proxyIncarnation: testIncarnation(3),
      proxyProcessGroupId: 200,
      canonicalEndpoint: '/tmp/proxy.sock',
    },
    registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    commitContainment: async () => ({ kind: 'containment-absent', disappearanceReceipt: 'gone' }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
    prepareOperation: vi.fn(),
    inspectOperation: vi.fn(),
    authorizeOperation: vi.fn(),
    activatePreparedOperation: vi.fn(),
    attachOperation: vi.fn(),
    cancelOperation: vi.fn(),
    settleOperation: vi.fn(),
    buildOperationControl: vi.fn(),
  };
}

describe('createAppServerProxyRoute', () => {
  it('fails closed when a selected set lacks durable replay operations', async () => {
    const set = authority();
    const { prepareOperation: _prepare, ...legacy } = set;
    const begin = vi.fn();
    const route = createAppServerProxyRoute({
      hostManager: { proxyHostRoot: () => '/test/plugin', routeAppServerOperation: () => legacy },
      reconciler: { begin },
      now: () => 10,
    });

    await expect(route.activate(request, new AbortController().signal)).rejects.toThrow(/durable operation replay/u);
    expect(begin).not.toHaveBeenCalled();
  });
});
