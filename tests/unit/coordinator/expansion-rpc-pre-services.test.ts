import { currentCoralStoreFormat } from '#src/store-format.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createMockKbDaemonSupervisor, createOnlineKbDaemonHealth } from '#tools/testing/kb-daemon-supervisor.js';

function makeRuntime(): Runtime {
  return {
    flavor: 'prod',
    time: {
      now: () => Date.now(),
      monotonicNow: () => process.hrtime.bigint() / 1_000_000n,
      sleep: async () => {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    storage: {
      existsSync: () => false,
      mkdirSync: () => {},
      readFileSync: () => '',
      readdirSync: () => [],
      rmSync: () => {},
      writeAtomicDurableSync: () => true,
      writeAtomicSync: () => {},
    },
    process: {
      observeLiveness: () => 'absent' as const,
      kill: () => {},
      readProcessIncarnation: () => testIncarnation(1_700_000_000),
    },
    ids: {
      uuid: () => '40000000-0000-4000-8000-000000000001',
      randomBytes: () => Buffer.alloc(32),
      sha256: () => 'sha256',
    },
    env: {
      get: () => undefined,
      homedir: () => '/home/user',
      tmpdir: () => '/tmp',
      fullSnapshot: () => ({}),
      cwd: () => process.cwd(),
      pid: () => process.pid,
      platform: () => process.platform,
      arch: () => process.arch,
      coralSnapshot: () => ({}),
    },
    paths: {
      projectSource: (projectRoot: string) => projectRoot,
      coral: {
        generation: {
          root: '/tmp/coral-expansion-pre-services',
          dataRoot: '/tmp/coral-expansion-pre-services/data',
          legacyDataRoot: '/tmp/coral-expansion-pre-services/legacy',
          adoptionLock: '/tmp/coral-expansion-pre-services/adoption.lock',
        },
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

function request(
  server: Server,
  url: string,
  options: { method?: string; headers: Record<string, string>; body?: string },
) {
  const incoming = new IncomingMessage(new Socket());
  incoming.method = options.method ?? 'GET';
  incoming.url = url;
  incoming.headers = options.headers;
  incoming.push(options.body ?? null);
  if (options.body !== undefined) incoming.push(null);
  const response = new ServerResponse(incoming);
  return new Promise<Response>((resolve) => {
    response.end = ((body: string) => {
      resolve(new Response(body, { status: response.statusCode }));
      return response;
    }) as typeof response.end;
    server.emit('request', incoming, response);
  });
}

describe('expansion RPC before store services exist', () => {
  it('routes through the KB daemon supervisor on a never-started server', async () => {
    const token = 'test-token';
    const bootToken = 'test-boot-token';
    const expansionRpc = vi.fn(async () => ({
      ok: true as const,
      data: {
        status: 'equipped',
        expansion: {
          name: 'vector',
          tier: 'installed',
          status: 'equipped',
        },
      },
    }));
    const core = createCoordinatorCore(
      {
        onFatalShutdownError: vi.fn(),
        storeFormat: currentCoralStoreFormat(),
        runtime: makeRuntime(),
        bootSnapshot: {
          version: 'test-version',
          bundleHash: 'test-bundle',
          flavor: 'prod',
          instanceId: 'test-instance',
          token,
          bootToken,
          now: () => 1_000,
          log: () => {},
        },
        createServerFn: (handler) => createServer(handler),
        kbDaemonSupervisor: createMockKbDaemonSupervisor({ expansionRpc }),
        getConsumerStuck: () => [],
      },
      async () => [],
    );

    const response = await request(core.server, '/coordinator/expansion', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coral-backend-token': token,
      },
      body: JSON.stringify({ name: 'vector' }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'equipped',
      expansion: {
        name: 'vector',
        tier: 'installed',
        status: 'equipped',
      },
    });
    expect(expansionRpc).toHaveBeenCalledWith(
      {
        method: 'equipExpansion',
        args: { name: 'vector' },
        ctx: expect.objectContaining({
          principal: expect.objectContaining({
            subject: 'operator',
            binding: { kind: 'unbound' },
          }),
        }),
      },
      expect.any(AbortSignal),
    );
  });

  it('surfaces daemon-owned mutation lock diagnostics through health without parent KB runtime access', async () => {
    const token = 'test-token';
    const bootToken = 'test-boot-token';
    const mutationBlocked = { owner: 'reindex', ageMs: 5000, signaledAtMs: 1234567890 };
    const core = createCoordinatorCore(
      {
        onFatalShutdownError: vi.fn(),
        storeFormat: currentCoralStoreFormat(),
        runtime: makeRuntime(),
        bootSnapshot: {
          version: 'test-version',
          bundleHash: 'test-bundle',
          flavor: 'prod',
          instanceId: 'test-instance',
          token,
          bootToken,
          now: () => 1_000,
          log: () => {},
        },
        createServerFn: (handler) => createServer(handler),
        kbDaemonSupervisor: createMockKbDaemonSupervisor({
          health: createOnlineKbDaemonHealth({
            kbWrite: { phase: 'ready', mutationBlocked },
          }),
        }),
        getConsumerStuck: () => [],
      },
      async () => [],
    );

    const response = await request(core.server, '/health?detailed=1', {
      headers: { 'x-coral-boot-token': bootToken },
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
