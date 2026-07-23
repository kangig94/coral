import { currentCoralStoreFormat } from '#src/store-format.js';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { probeProcessStartedAtSeconds } from '#src/infra/node-process.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Database } from '#src/store/db.js';
import { closeIpcServer, listenIpcServer, type IpcListener } from '#src/transport/ipc/server.js';
import {
  decode,
  encode,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';
import type { IncumbentHealth } from '#src/transport/ipc/handoff.js';
import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const tempRoots: string[] = [];
const httpServers = new Set<HttpServer>();
const ipcListeners = new Set<IpcListener>();
const netServers = new Set<NetServer>();

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function withHome<T>(home: string, fn: () => T): T {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

function createRuntime(): Runtime {
  return withHome(tempRoot('coral-incumbent-handoff-home-'), () => createRealRuntime('prod'));
}

function createMismatchStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE incumbent_owned_store (id INTEGER PRIMARY KEY);
      INSERT INTO incumbent_owned_store (id) VALUES (1);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', 'sha256:obsolete');
    `);
  } finally {
    db.close();
  }
}

function readStoreFormatFingerprint(dbPath: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta' LIMIT 1").get() === undefined) {
      return undefined;
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint'").get() as
      | { value?: string }
      | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, table: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== undefined;
  } finally {
    db.close();
  }
}

async function listenHttp(server: HttpServer): Promise<{ port: number; host: string }> {
  if (server.listening) {
    const address = server.address();
    if (address && typeof address !== 'string') {
      return { port: address.port, host: '127.0.0.1' };
    }
  }

  httpServers.add(server);
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('HTTP server did not bind to a TCP port'));
        return;
      }
      resolve({ port: address.port, host: '127.0.0.1' });
    });
  });
}

async function closeHttp(server: HttpServer): Promise<void> {
  httpServers.delete(server);
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function startScriptedIncumbent(
  socketPath: string,
  reply: (request: JsonRpcRequestEnvelope) => Promise<JsonRpcResponseEnvelope>,
): Promise<NetServer> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createNetServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      void (async () => {
        buffer += chunk.toString('utf-8');
        const frames = buffer.split('\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.trim().length === 0) {
            continue;
          }
          const request = decode(frame);
          if (request.kind !== 'request') {
            continue;
          }
          socket.end(`${encode(await reply(request))}\n`);
        }
      })().catch(() => socket.destroy());
    });
  });
  netServers.add(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

async function closeNet(server: NetServer): Promise<void> {
  netServers.delete(server);
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

function createStoreServices(storeDb: Database, runtime: Runtime, namespace: string): CoordinatorStoreServices {
  return {
    storeDb,
    progressStore: new JobStore(namespace, runtime, createEventBodyCodec(), {
      db: storeDb,
      reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
      providers: permissiveProviderLookupPort,
    }),
    consumerDriver: null,
  };
}

afterEach(async () => {
  for (const listener of [...ipcListeners].reverse()) {
    ipcListeners.delete(listener);
    try {
      await closeIpcServer(listener);
    } catch {
      // best effort
    }
  }
  for (const server of [...httpServers].reverse()) {
    try {
      await closeHttp(server);
    } catch {
      // best effort
    }
  }
  for (const server of [...netServers].reverse()) {
    try {
      await closeNet(server);
    } catch {
      // best effort
    }
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('incumbent handoff reset authority', () => {
  it('serves pre-service health/errors and waits for incumbent handoff before resetting the old store', async () => {
    const runtime = createRuntime();
    const token = 'test-token';
    const bootToken = 'test-boot-token';
    const shutdownToken = 'test-shutdown-token';
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const incumbentStore = new DatabaseSync(dbPath);
    let shutdownReceived = false;
    const processStartedAt = probeProcessStartedAtSeconds(process.pid, runtime.env.platform() as NodeJS.Platform) ?? 1;
    writeDiscoveryRecord(
      {
        pid: process.pid,
        port: 1,
        socketPath: runtime.paths.coral.coordinator.socketPath,
        bundleHash: 'old-bundle',
        flavor: 'prod',
        namespace: 'ns',
        startedAt: Date.now(),
        token,
        bootToken,
        shutdownToken,
        processStartedAt,
      },
      { storage: runtime.storage, env: runtime.env, paths: runtime.paths },
    );

    const incumbent = await startScriptedIncumbent(runtime.paths.coral.coordinator.socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            bundleHash: 'old-bundle',
            version: '0.8.7',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: process.pid,
            processStartedAt,
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        shutdownReceived = true;
        expect(request.auth).toEqual({ kind: 'boot', token: bootToken });
        expect(request.params).toEqual({});
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    const core = createCoordinatorCore({
      storeFormat: currentCoralStoreFormat(),
      runtime,
      backendNamespace: 'ns',
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'new-bundle',
        flavor: 'prod',
        instanceId: 'replacement',
        token,
        bootToken: 'replacement-boot-token',
        shutdownToken: 'replacement-shutdown-token',
        now: () => Date.now(),
        log: () => {},
      },
      createServerFn: (handler) => createServer(handler),
      listenFn: listenHttp,
      closeServerFn: closeHttp,
      listenIpcFn: async (listener) => {
        const result = await listenIpcServer(listener, runtime.paths.coral.coordinator.socketPath);
        ipcListeners.add(listener);
        return result;
      },
      createStoreServicesFromDbFn: (storeDb) => createStoreServices(storeDb, runtime, 'ns'),
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      runStartupRecoveryFn: async () => [],
      cleanupStaleJobsFn: () => {},
      markJobsAsErrorFn: () => {},
      terminateAllFn: () => {},
      registerBuiltInProvidersFn: () => {},
      getConsumerStuck: () => {
        throw new Error('getConsumerStuck must not run before store services exist');
      },
    });

    try {
      const httpInfo = await listenHttp(core.server);
      const healthResponse = await fetch(`http://${httpInfo.host}:${httpInfo.port}/health?detailed`, {
        headers: { 'x-coral-boot-token': 'replacement-boot-token' },
      });
      const health = (await healthResponse.json()) as Record<string, unknown>;
      expect(healthResponse.status).toBe(200);
      expect(health).toMatchObject({ status: 'starting', activeJobs: 0 });

      const rpcResponse = await fetch(`http://${httpInfo.host}:${httpInfo.port}/coordinator/expansion`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-coral-backend-token': token,
        },
        body: JSON.stringify({ name: 'needle' }),
      });
      const rpcBody = (await rpcResponse.json()) as Record<string, unknown>;
      expect(rpcResponse.status).toBe(200);
      expect(rpcBody).toMatchObject({
        servedBy: 'kb-daemon',
        method: 'equipExpansion',
      });

      const startPromise = core.lifecycleController.start();
      await waitFor(() => shutdownReceived);

      expect(readStoreFormatFingerprint(dbPath)).toBe('sha256:obsolete');
      expect(tableExists(dbPath, 'incumbent_owned_store')).toBe(true);

      incumbentStore.close();
      await closeNet(incumbent);

      await startPromise;

      expect(core.storeServicesRef.tryGet()).not.toBeNull();
      expect(readStoreFormatFingerprint(dbPath)).toBe(currentCoralStoreFormat().fingerprint);
      expect(tableExists(dbPath, 'incumbent_owned_store')).toBe(false);

      const postResetStore = core.storeServicesRef.get().progressStore;
      postResetStore.appendLaunchRequested('post-reset-kb-job', {
        jobId: 'post-reset-kb-job',
        owner: { kind: 'system-task', id: 'kb.reindex:post-reset-kb-job' },
        sessionId: null,
        provider: null,
        projectRoot: '/post-reset',
        backendNamespace: 'ns',
        jobKind: 'kb',
        pool: 'curate',
        enqueueSequence: postResetStore.nextEnqueueSequence(),
        operation: 'kb.reindex',
        request: {},
        createdAt: '2026-07-23T00:00:00.000Z',
      });
      expect(postResetStore.readStatus('post-reset-kb-job')).toMatchObject({
        phase: 'launching',
        backendNamespace: 'ns',
        jobKind: 'kb',
      });
    } finally {
      try {
        incumbentStore.close();
      } catch {
        // already closed
      }
      try {
        await core.lifecycleController.shutdown('test-cleanup');
        await core.lifecycleController.waitForShutdown();
      } catch {
        // startup may have failed before lifecycle ownership existed
      }
      await closeNet(incumbent);
    }
  }, 20_000);
});
