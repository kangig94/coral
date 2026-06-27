import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createMockKbDaemonSupervisor, createOnlineKbDaemonHealth } from '#tools/testing/kb-daemon-supervisor.js';

const openServers = new Set<Server>();

function makeRuntime(): Runtime {
  return {
    flavor: 'prod',
    time: {
      now: () => Date.now(),
      sleep: async () => {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    storage: {
      mkdirSync: () => {},
      rmSync: () => {},
      writeAtomicSync: () => {},
    },
    process: {
      isAlive: () => false,
      kill: () => {},
    },
    ids: {
      uuid: () => 'uuid',
      randomBytes: () => Buffer.alloc(32),
      sha256: () => 'sha256',
    },
    env: {
      get: () => undefined,
      cwd: () => process.cwd(),
      pid: () => process.pid,
      platform: () => process.platform,
      arch: () => process.arch,
      coralSnapshot: () => ({}),
    },
    paths: {
      projectSource: (projectRoot: string) => projectRoot,
      coral: {
        coordinator: {
          socketPath: '/tmp/coral-expansion-pre-services.sock',
          runDir: '/tmp',
          infoFile: '/tmp/coral-expansion-pre-services.json',
        },
        store: {
          dbDir: '/tmp/coral-expansion-pre-services-store',
          dbFile: '/tmp/coral-expansion-pre-services-store/store.db',
          walFile: '/tmp/coral-expansion-pre-services-store/store.db-wal',
          shmFile: '/tmp/coral-expansion-pre-services-store/store.db-shm',
        },
        exports: { jobsRoot: '/tmp/coral-expansion-pre-services-jobs' },
        corpus: {
          kbRoot: '/tmp/coral-expansion-pre-services-kb',
          notesDir: '/tmp/coral-expansion-pre-services-kb/notes',
          sourcesDir: '/tmp/coral-expansion-pre-services-kb/sources',
          principlesDir: '/tmp/coral-expansion-pre-services-kb/principles',
          communitiesDir: '/tmp/coral-expansion-pre-services-kb/communities',
        },
        engine: {
          engineRoot: '/tmp/coral-expansion-pre-services-engines',
          dataDir: (name: string) => `/tmp/coral-expansion-pre-services-engines/${name}`,
          installLockPath: (name: string) => `/tmp/coral-expansion-pre-services-engines/${name}/install.lock`,
        },
      },
    },
  } as unknown as Runtime;
}

async function listen(server: Server): Promise<number> {
  openServers.add(server);
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    openServers.delete(server);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      openServers.delete(server);
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all([...openServers].map(closeServer));
});

describe('expansion RPC before store services exist', () => {
  it('routes through the KB daemon supervisor on a never-started server', async () => {
    const token = 'test-token';
    const expansionRpc = vi.fn(async () => ({
      ok: true as const,
      data: {
        status: 'equipped',
        expansion: {
          name: 'needle',
          tier: 'installed',
          status: 'equipped',
        },
      },
    }));
    const core = createCoordinatorCore({
      runtime: makeRuntime(),
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'test-instance',
        token,
        now: () => 1_000,
        log: () => {},
      },
      createServerFn: (handler) => createServer(handler),
      kbDaemonSupervisor: createMockKbDaemonSupervisor({ expansionRpc }),
      runStartupRecoveryFn: async () => [],
      getConsumerStuck: () => [],
    });

    const port = await listen(core.server);
    const response = await fetch(`http://127.0.0.1:${port}/coordinator/expansion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coral-backend-token': token,
      },
      body: JSON.stringify({ name: 'needle' }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'equipped',
      expansion: {
        name: 'needle',
        tier: 'installed',
        status: 'equipped',
      },
    });
    expect(expansionRpc).toHaveBeenCalledWith({ method: 'equipExpansion', args: { name: 'needle' } });
  });

  it.each([
    {
      code: 'kb_unavailable',
      statusCode: 503,
      message: 'KB daemon expansion request skipped: recovery ended in failed.',
      remediation: 'Wait for the KB daemon runtime to become available.',
      detail: { reason: 'kb_daemon_unavailable' },
    },
    {
      code: 'unknown_expansion',
      statusCode: 500,
      message: 'The expansion needle is not registered in the Coral catalog.',
      remediation: "Run 'coral-cli expansion list' to see available expansions.",
      detail: { name: 'needle' },
    },
  ])('surfaces child expansion $code failures without collapsing to internal_error', async (failure) => {
    const token = 'test-token';
    const expansionRpc = vi.fn(async () => ({
      ok: false as const,
      code: failure.code,
      message: failure.message,
      remediation: failure.remediation,
      detail: failure.detail,
    }));
    const core = createCoordinatorCore({
      runtime: makeRuntime(),
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'test-instance',
        token,
        now: () => 1_000,
        log: () => {},
      },
      createServerFn: (handler) => createServer(handler),
      kbDaemonSupervisor: createMockKbDaemonSupervisor({ expansionRpc }),
      runStartupRecoveryFn: async () => [],
      getConsumerStuck: () => [],
    });

    const port = await listen(core.server);
    const response = await fetch(`http://127.0.0.1:${port}/coordinator/expansion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coral-backend-token': token,
      },
      body: JSON.stringify({ name: 'needle' }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(failure.statusCode);
    expect(body).toMatchObject({
      code: failure.code,
      message: failure.message,
      userMessage: failure.message,
      remediation: failure.remediation,
      context: failure.detail,
    });
  });

  it('surfaces daemon-owned mutation lock diagnostics through health without parent KB runtime access', async () => {
    const token = 'test-token';
    const mutationBlocked = { owner: 'reindex', ageMs: 5000, signaledAtMs: 1234567890 };
    const core = createCoordinatorCore({
      runtime: makeRuntime(),
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'test-instance',
        token,
        now: () => 1_000,
        log: () => {},
      },
      createServerFn: (handler) => createServer(handler),
      kbDaemonSupervisor: createMockKbDaemonSupervisor({
        health: createOnlineKbDaemonHealth({
          kbWrite: { phase: 'ready', mutationBlocked },
        }),
      }),
      runStartupRecoveryFn: async () => [],
      getConsumerStuck: () => [],
    });

    const port = await listen(core.server);
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'x-coral-backend-token': token },
    });
    const body = (await response.json()) as {
      diagnostics?: { mutationBlocked?: unknown };
      kbDaemon?: { kbWrite?: { mutationBlocked?: unknown } };
    };

    expect(response.status).toBe(200);
    expect(body.kbDaemon?.kbWrite?.mutationBlocked).toEqual(mutationBlocked);
    expect(body.diagnostics?.mutationBlocked).toEqual(mutationBlocked);
  });
});
