import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { Runtime } from '#src/runtime/ports.js';

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
  it('returns documented startup_not_ready through transport on a never-started server', async () => {
    const token = 'test-token';
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
      runStartupRecoveryFn: async () => [],
      getConsumerStuck: () => [],
      getMutationBlocked: () => ({ blocked: false }),
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

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      code: 'startup_not_ready',
      message: 'Coral backend is still starting.',
      remediation: 'The Coral backend is still starting; retry shortly.',
    });
  });
});
