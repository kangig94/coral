import { ExecutionFinisher } from '#src/jobs/finishing.js';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorWorld } from '#src/coordinator/composition/world.js';
import type { BackendDefaultsPlan } from '#src/coordinator/composition/defaults.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import {
  authorizeProviderProxySetContainmentProof,
  releaseProviderProxySetContainmentProofFence,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { insertProviderOperation, providerOperationMutationAdmission } from '#src/store/provider-operation-journal.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function idleExecutionFinisher(runtime: Pick<Runtime, 'time'>): ExecutionFinisher {
  return new ExecutionFinisher({
    time: runtime.time,
    commit: () => {
      throw new Error('Execution writes are unexpected before store services start');
    },
    read: () => {
      throw new Error('Execution reads are unexpected before store services start');
    },
    quiesce: async () => {
      throw new Error('Execution settlement is unexpected before store services start');
    },
    retentionAction: async () => {
      throw new Error('Retention is unexpected before store services start');
    },
    settleRetention: async () => {
      throw new Error('Retention is unexpected before store services start');
    },
  });
}

const REMOTE_BIND_OPT_IN_ENV = 'CORAL_BACKEND_ALLOW_REMOTE';
const REMOTE_BIND_ADDRESS_ALLOWLIST_ENV = 'CORAL_BACKEND_REMOTE_ADDR_ALLOWLIST';
const REMOTE_BIND_UNRESTRICTED_ENV = 'CORAL_BACKEND_REMOTE_UNRESTRICTED';
const SYSTEM_PROVIDER_SCOPE_ENV = 'CORAL_SYSTEM_PROVIDER_SCOPE';

function envSnapshot(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function createRuntime(
  env: Readonly<Record<string, string | undefined>>,
  uuid: () => string = () => 'world-test-instance',
): Runtime {
  return {
    flavor: 'prod',
    env: {
      get: (key: string) => env[key],
      homedir: () => '/tmp',
      tmpdir: () => '/tmp',
      pid: () => 4242,
      platform: () => 'linux',
      arch: () => 'x64',
      cwd: () => '/tmp',
      fullSnapshot: () => envSnapshot(env),
      coralSnapshot: () => envSnapshot(env),
    },
    ids: {
      uuid,
      randomBytes: (size: number) => Buffer.alloc(size, 1),
      sha256: (input: string) => input,
    },
    time: {
      now: () => 123,
      monotonicNow: () => 123n,
      sleep: async () => undefined,
      setTimeout: () => ({}),
      clearTimeout: () => undefined,
      setInterval: () => ({}),
      clearInterval: () => undefined,
    },
    storage: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error('readFileSync was not expected');
      },
    } as unknown as Runtime['storage'],
    process: {} as unknown as Runtime['process'],
    paths: {
      projectSource: (projectRoot: string) => projectRoot,
      projectData: (projectRoot: string) => projectRoot,
      coral: {} as Runtime['paths']['coral'],
    },
  };
}

function createDefaultsPlan(): BackendDefaultsPlan {
  return {
    eager: {
      resolvedPluginRoot: '/tmp/coral-world-test-plugin',
      createIdleTimer: () => ({}) as never,
    },
    finalizeWithWorld: () => {
      throw new Error('finalizeWithWorld was not expected');
    },
  } as unknown as BackendDefaultsPlan;
}

function createWorld(
  env: Readonly<Record<string, string | undefined>>,
  overrides: { uuid?: () => string; buildSetId?: string; runtime?: Runtime } = {},
): ReturnType<typeof createCoordinatorWorld> {
  const runtime = overrides.runtime ?? createRuntime(env, overrides.uuid);
  return createCoordinatorWorld(
    {
      runtime,
      executionFinisher: idleExecutionFinisher(runtime),
      storeFormat: currentCoralStoreFormat(),
      bootSnapshot: {
        version: 'world-test-version',
        bundleHash: 'world-test-bundle',
        flavor: 'prod',
        instanceId: 'world-test-instance',
        token: 'world-test-token',
        pid: 4242,
        now: () => 123,
        log: () => undefined,
        buildSetId: overrides.buildSetId,
      },
      backendNamespace: 'world-test-namespace',
      getConsumerStuck: () => [],
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      launchCoordinator: {} as never,
      providerHostManager: {
        openSession: async () => {
          throw new Error('openSession was not expected');
        },
        attachSession: async () => null,
        drainForHandoff: async () => undefined,
        shutdown: async () => undefined,
      } as never,
    },
    runtime,
    createDefaultsPlan(),
  );
}

it.each(['missing', 'absent'] as const)(
  'preserves lifecycle leaf history through the world reaper before a final %s observation',
  async (after) => {
    const runtime = new SimulationRuntime();
    const record = providerOperationRecord('executing');
    const identity = providerProxySetIdentityFromRecord(record);
    let observation: FailureDomainObservation = { kind: 'missing' };
    let reaping = false;
    const kill = vi.fn(() => ({ kind: 'entered' as const }));
    vi.spyOn(runtime.process, 'failureDomainContainment').mockImplementation(() => {
      if (reaping) observation = { kind: 'absent' };
      return { observe: () => observation, kill };
    });
    const world = createWorld({}, { runtime });
    world.providerProxyClaims.initialize([record]);
    const unexpected = (): never => {
      throw new Error('Unexpected recovery operation during world reaping.');
    };
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: identity.buildSetId,
      claims: world.providerProxyClaims,
      capacity: { maxSets: 1, idleRetirement: { kind: 'never' } },
      time: runtime.time,
      controlEstablished: unexpected,
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'disappearance-consumer': async () => ({
          kind: 'accepted',
          acceptance: { kind: 'accepted', operation: record.operation, disposition: 'record-absent' },
        }),
      }),
      reapRecordedContainment: world.reapRecordedContainment,
      failureDomainContainment: runtime.process.failureDomainContainment,
      operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(runtime.storage, '/world/run'),
      writerIncarnation: 'world-test-writer',
      collectOperatorDispositionContainmentProof: unexpected,
      reobserveAcquisitionContainment: unexpected,
      reportLifecycle: () => {},
    });
    world.providerProxyLifecycleRef.connect(lifecycle);
    expect(lifecycle.activateDurableOperatorDispositions()).toEqual({ kind: 'recorded' });
    lifecycle.initializeClaimSlots();
    const leafAbsent = lifecycle.containmentAbsenceObserver(identity);
    expect(leafAbsent()).toBe(true);
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    insertProviderOperation(db, record);
    const signal = new AbortController().signal;
    const proof = await world.providerProxySetContainmentProver.collectContainmentProof(
      authorizeProviderProxySetContainmentProof(identity, {
        mutationFence: providerOperationMutationAdmission(db).closeSet(identity),
        closeAdmission: async () => {},
      }),
      db,
      signal,
    );
    try {
      reaping = true;
      const result = await world.reapRecordedContainment(identity, proof, signal, () => {});
      if (result.kind !== 'containment-absent') throw new Error(`Expected absence, got ${result.kind}`);
      observation = { kind: after };
      const acceptance = lifecycle.containmentAbsent(identity, result.disappearanceReceipt);
      if (after === 'missing') {
        expect(acceptance).toEqual({ kind: 'held' });
        expect(lifecycle.snapshot().represented).toBe(1);
      } else {
        expect(acceptance.kind).toBe('accepted');
        if (acceptance.kind === 'accepted') await acceptance.initialDisposition;
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      releaseProviderProxySetContainmentProofFence(proof);
      db.close();
    }
  },
);

describe('createCoordinatorWorld bind host guard', () => {
  it('defaults to loopback without remote opt-in', () => {
    const world = createWorld({});

    expect(world.bindHost).toBe('127.0.0.1');
    expect(world.remoteAccess).toEqual({ mode: 'loopback' });
  });

  it.each(['127.0.0.0', '127.0.0.1', '127.255.255.255', '::1', 'localhost'])(
    'allows loopback bind host %s without remote opt-in',
    (bindHost: string) => {
      const world = createWorld({ CORAL_BACKEND_BIND: bindHost });

      expect(world.bindHost).toBe(bindHost);
      expect(world.remoteAccess).toEqual({ mode: 'loopback' });
    },
  );

  it('refuses a non-loopback bind host without explicit remote opt-in', () => {
    let thrown: unknown;

    try {
      createWorld({ CORAL_BACKEND_BIND: '0.0.0.0' });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    const setupError = thrown as CoralSetupError;
    expect(setupError.code).toBe('backend_remote_bind_requires_opt_in');
    expect(setupError.userMessage).toContain("non-loopback host '0.0.0.0'");
    expect(setupError.userMessage).toContain(`${REMOTE_BIND_OPT_IN_ENV}=1`);
    expect(setupError.remediation).toContain(`${REMOTE_BIND_OPT_IN_ENV}=1`);
    expect(setupError.context).toEqual({ bindHost: '0.0.0.0', optInEnv: REMOTE_BIND_OPT_IN_ENV });
  });

  it('refuses a non-loopback bind host with remote opt-in but no access policy', () => {
    let thrown: unknown;

    try {
      createWorld({ CORAL_BACKEND_BIND: '0.0.0.0', [REMOTE_BIND_OPT_IN_ENV]: '1' });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    const setupError = thrown as CoralSetupError;
    expect(setupError.code).toBe('backend_remote_bind_requires_access_policy');
    expect(setupError.remediation).toContain(REMOTE_BIND_ADDRESS_ALLOWLIST_ENV);
    expect(setupError.remediation).toContain(REMOTE_BIND_UNRESTRICTED_ENV);
  });

  it('allows a non-loopback bind host with explicit remote opt-in and address allowlist', () => {
    const world = createWorld({
      CORAL_BACKEND_BIND: '0.0.0.0',
      [REMOTE_BIND_OPT_IN_ENV]: '1',
      [REMOTE_BIND_ADDRESS_ALLOWLIST_ENV]:
        '203.0.113.10, ::ffff:198.51.100.8, 2001:0db8:0000:0000:0000:ff00:0042:8329, 203.0.113.10',
    });

    expect(world.bindHost).toBe('0.0.0.0');
    expect(world.remoteAccess).toEqual({
      mode: 'address_allowlist',
      allowedRemoteAddresses: ['203.0.113.10', '198.51.100.8', '2001:db8::ff00:42:8329'],
    });
  });

  it('allows an explicitly unrestricted non-loopback bind host', () => {
    const world = createWorld({
      CORAL_BACKEND_BIND: '0.0.0.0',
      [REMOTE_BIND_OPT_IN_ENV]: '1',
      [REMOTE_BIND_UNRESTRICTED_ENV]: '1',
    });

    expect(world.bindHost).toBe('0.0.0.0');
    expect(world.remoteAccess).toEqual({ mode: 'unrestricted' });
  });

  it('rejects malformed remote address allowlist entries', () => {
    let thrown: unknown;

    try {
      createWorld({
        CORAL_BACKEND_BIND: '0.0.0.0',
        [REMOTE_BIND_OPT_IN_ENV]: '1',
        [REMOTE_BIND_ADDRESS_ALLOWLIST_ENV]: '203.0.113.0/24',
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    const setupError = thrown as CoralSetupError;
    expect(setupError.code).toBe('backend_remote_bind_invalid_allowlist');
  });
});

describe('createCoordinatorWorld system provider scope', () => {
  const systemScope = {
    origin: 'system',
    name: 'automation',
    profiles: [
      {
        provider: 'codex',
        profile: { canonicalLocation: '/accounts/codex-system', routing: { kind: 'home' } },
      },
    ],
  } as const;

  it('loads a strict named system scope from daemon boot configuration', () => {
    const world = createWorld({ [SYSTEM_PROVIDER_SCOPE_ENV]: JSON.stringify(systemScope) });

    expect(world.systemProviderScope).toEqual(systemScope);
  });

  it.each([
    ['caller origin', { ...systemScope, origin: 'caller', name: undefined }],
    ['missing name', { origin: 'system', profiles: systemScope.profiles }],
    ['unknown field', { ...systemScope, ambient: true }],
  ])('rejects %s before coordinator composition', (_name, value) => {
    expect(() => createWorld({ [SYSTEM_PROVIDER_SCOPE_ENV]: JSON.stringify(value) })).toThrowError(
      expect.objectContaining({ code: 'system_provider_scope_invalid' }),
    );
  });
});
