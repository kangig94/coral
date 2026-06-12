import { describe, expect, it } from 'vitest';

import { createCoordinatorWorld } from '#src/coordinator/composition/world.js';
import type { BackendDefaultsPlan } from '#src/coordinator/composition/defaults.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { Runtime } from '#src/runtime/ports.js';

const REMOTE_BIND_OPT_IN_ENV = 'CORAL_BACKEND_ALLOW_REMOTE';

function envSnapshot(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function createRuntime(env: Readonly<Record<string, string | undefined>>): Runtime {
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
      uuid: () => 'world-test-instance',
      randomBytes: (size: number) => Buffer.alloc(size, 1),
      sha256: (input: string) => input,
    },
    time: {
      now: () => 123,
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

function createWorld(env: Readonly<Record<string, string | undefined>>): ReturnType<typeof createCoordinatorWorld> {
  const runtime = createRuntime(env);
  return createCoordinatorWorld(
    {
      runtime,
      bootSnapshot: {
        version: 'world-test-version',
        bundleHash: 'world-test-bundle',
        flavor: 'prod',
        instanceId: 'world-test-instance',
        token: 'world-test-token',
        pid: 4242,
        now: () => 123,
        log: () => undefined,
      },
      backendNamespace: 'world-test-namespace',
      runStartupRecoveryFn: async () => [],
      getConsumerStuck: () => [],
      getMutationBlocked: () => ({ blocked: false }),
      launchCoordinator: {} as never,
      providerHostManager: {
        acquireServer: async () => {
          throw new Error('acquireServer was not expected');
        },
        borrowLiveServer: async () => null,
        drainForHandoff: async () => undefined,
        shutdown: async () => undefined,
      } as never,
    },
    runtime,
    createDefaultsPlan(),
  );
}

describe('createCoordinatorWorld bind host guard', () => {
  it('defaults to loopback without remote opt-in', () => {
    const world = createWorld({});

    expect(world.bindHost).toBe('127.0.0.1');
  });

  it.each(['127.0.0.0', '127.0.0.1', '127.255.255.255', '::1', 'localhost'])(
    'allows loopback bind host %s without remote opt-in',
    (bindHost: string) => {
      const world = createWorld({ CORAL_BACKEND_BIND: bindHost });

      expect(world.bindHost).toBe(bindHost);
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

  it('allows a non-loopback bind host with explicit remote opt-in', () => {
    const world = createWorld({ CORAL_BACKEND_BIND: '0.0.0.0', [REMOTE_BIND_OPT_IN_ENV]: '1' });

    expect(world.bindHost).toBe('0.0.0.0');
  });
});
