import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderProxySetAuthority,
  type ProviderProxySetAuthorityDependencies,
} from '#src/coordinator/live/provider-proxy/set-authority.js';
import { ControlClientError, controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import type {
  CoordinatorIdentity,
  GuardianIdentity,
  ProxyIdentity,
  ReaperIdentity,
} from '#src/provider-proxy/protocol.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';

const GUARDIAN_IDENTITY: GuardianIdentity = {
  guardianInstanceId: '11111111-1111-4111-8111-111111111111',
  pid: 100,
  incarnation: testIncarnation(1_000),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const REAPER_IDENTITY: ReaperIdentity = {
  reaperInstanceId: '22222222-2222-4222-8222-222222222222',
  pid: 101,
  incarnation: testIncarnation(1_000),
  guardianInstanceId: GUARDIAN_IDENTITY.guardianInstanceId,
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-process-group',
};

const PROXY_IDENTITY: ProxyIdentity = {
  proxyInstanceId: '33333333-3333-4333-8333-333333333333',
  pid: 102,
  incarnation: testIncarnation(1_000),
  processGroupId: 102,
  guardianInstanceId: GUARDIAN_IDENTITY.guardianInstanceId,
  reaperInstanceId: REAPER_IDENTITY.reaperInstanceId,
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalEndpoint: '/tmp/proxy.sock',
};

const COORDINATOR_IDENTITY: CoordinatorIdentity = {
  instanceId: '55555555-5555-4555-8555-555555555555',
  pid: 1,
  incarnation: testIncarnation(900),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: GUARDIAN_IDENTITY.buildSetId,
};

/** A client that must never be called — a test that reaches it is exercising a path it did not mean to. */
function unreachableClient(): ControlClient {
  return {
    exchange: () => {
      throw new Error('unreachable: this client was not expected to exchange');
    },
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => {},
  };
}

function inactiveHeartbeats() {
  return {
    proxy: { stop: () => undefined },
    guardian: { stop: () => undefined },
    reaper: { stop: () => undefined },
  };
}

/** `runtime.ids`/`storage` plus the default deadline configuration for the `stopAndReap`-only blocks below. */
function unusedRuntimePorts(): Runtime {
  const fail = (member: string) => (): never => {
    throw new Error(`unexpected use of runtime.${member} during stopAndReap`);
  };
  return {
    ids: { uuid: fail('ids.uuid'), randomBytes: fail('ids.randomBytes') } as unknown as Runtime['ids'],
    env: { get: () => undefined } as unknown as Runtime['env'],
    storage: new Proxy({}, { get: fail('storage') }) as unknown as Runtime['storage'],
  } as unknown as Runtime;
}

function authorityWithGuardianClient(
  guardianClient: ControlClient,
  providerRoots: ReadonlyArray<{ pid: number; incarnation: ProcessIncarnation }> = [],
): ReturnType<typeof createProviderProxySetAuthority> {
  const deps: ProviderProxySetAuthorityDependencies = {
    proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
    guardianClient,
    proxyClient: unreachableClient(),
    reaperClient: guardianClient,
    guardianIdentity: GUARDIAN_IDENTITY,
    reaperIdentity: REAPER_IDENTITY,
    proxyIdentityFields: PROXY_IDENTITY,
    heartbeats: inactiveHeartbeats(),
    coordinatorIdentity: COORDINATOR_IDENTITY,
    handoffCapsulePath: '/dev/null/unused-handoff-capsule.json',
    runtime: unusedRuntimePorts(),
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => providerRoots },
  };
  return createProviderProxySetAuthority(deps);
}

describe('createProviderProxySetAuthority: commitContainment', () => {
  it('reports outcome-unknown when the response is lost after the request may have reached the guardian', async () => {
    const guardianClient: ControlClient = {
      exchange: () =>
        Promise.resolve(
          controlExchangeForTest({
            kind: 'no-response',
            cause: 'connection-closed-after-write',
            error: new ControlClientError('control_client_closed', 'closed after write', 'closed'),
          }),
        ),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
    const authority = authorityWithGuardianClient(guardianClient);

    const outcome = await authority.commitContainment(new AbortController().signal);

    expect(outcome.kind).toBe('outcome-unknown');
  });
});

describe('createProviderProxySetAuthority: continuous recovery', () => {
  type InstallCall = { role: string; method: string; params: unknown };

  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function recordingClient(role: string, calls: InstallCall[], installGate: Promise<void>): ControlClient {
    return {
      exchange: async (method, params) => {
        calls.push({ role, method, params });
        await installGate;
        return controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'result',
            value: { state: 'installed-dormant', grantId: (params as { grantId: string }).grantId },
          },
        });
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
  }

  it('shares one in-flight install attempt between concurrent callers', async () => {
    const calls: InstallCall[] = [];
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const tempRoot = mkdtempSync(join(tmpdir(), 'coral-install-handoff-grant-'));
    tempRoots.push(tempRoot);
    const authority = createProviderProxySetAuthority({
      proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
      guardianClient: recordingClient('guardian', calls, installGate),
      reaperClient: recordingClient('reaper', calls, installGate),
      proxyClient: recordingClient('proxy', calls, installGate),
      guardianIdentity: GUARDIAN_IDENTITY,
      reaperIdentity: REAPER_IDENTITY,
      proxyIdentityFields: PROXY_IDENTITY,
      heartbeats: inactiveHeartbeats(),
      coordinatorIdentity: COORDINATOR_IDENTITY,
      handoffCapsulePath: join(tempRoot, 'proxy.handoff.json'),
      runtime: createRealRuntime('dev', { baseDir: tempRoot }),
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    });

    const first = authority.installRecoveryCredential(new AbortController().signal);
    const second = authority.installRecoveryCredential(new AbortController().signal);

    expect(
      calls.filter(({ method }) => method.includes('handoff-install') || method === 'handoff.install.v1'),
    ).toHaveLength(3);
    releaseInstall();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome).toMatchObject({ kind: 'installed' });
    expect(secondOutcome).toEqual(firstOutcome);
  });
});
