import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createRealRuntime } from '#src/runtime/real.js';
import { socketPathForRunDir } from '#src/infra/path/index.js';
import { replacementServing } from '#src/coordinator-launch/health.js';
import { createCoordinatorHealthReader } from '#src/coordinator/composition/health-observation.js';
import { providerOperationStartupStatusSchema } from '#src/transport/server-ports.js';
import { randomUUID } from 'node:crypto';
import { publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { SENTINEL_TIMING } from '#src/infra/sentinel-timing.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { reconcileInheritedChildren } from '#src/coordinator-launch/inherited-children.js';
import { STARTUP_BUDGET_MS } from '#src/coordinator-launch/timing.js';

it.each([
  [10, 'snapshot'],
  [400, 'snapshot'],
  [10, 'oversized'],
  [10, 'malformed'],
  [10, 'truncated'],
  [10, 'invalid-status'],
  [10, 'wrong-pid'],
  [10, 'starting'],
] as const)('observes %s pending startup sets with a %s response', async (setCount, reply) => {
  const root = mkdtempSync('/tmp/coral-health-');
  const runtime = createRealRuntime('prod', { baseDir: root });
  const runDir = runtime.paths.coral.coordinator.runDir;
  mkdirSync(runDir, { recursive: true });
  const startup = providerOperationStartupStatusSchema.parse({
    phase: 'detached',
    elapsedMs: 20000,
    boundMs: 10000,
    sets: Array.from({ length: setCount }, (_, i) => ({
      setKey: `provider-set-${i}-${'a'.repeat(64)}`,
      state: 'queued',
      pendingMutations: [],
      pendingFences: [],
      incident: null,
      successor: 'detached-startup-recovery',
    })),
  });
  const read = createCoordinatorHealthReader({
    runtime,
    world: {
      identity: {
        version: '0.10.16',
        bundleHash: 'hash',
        flavor: 'prod',
        namespace: 'test',
        instanceId: 'test',
        now: Date.now,
      },
      coralEnvSnapshot: {},
      storeServicesRef: {
        tryGet: () => ({
          progressStore: {
            listStoredNonterminalJobIds: () => [],
            getDb: () => ({ prepare: () => ({ get: () => ({ seq: 0 }) }) }),
          },
        }),
      },
      backendPid: process.pid,
      idleTimer: { isDraining: false, inflightRequests: 0 },
      discussRegistry: { contexts: new Map() },
      launchCoordinator: {
        active: 0,
        queueDepth: () => 0,
        activeLaunchPermits: () => [],
        launchReleaseDiagnostics: () => [],
        launchReclamationDiagnostics: () => [],
      },
      providerProxyLifecycleRef: { get: () => null },
    } as never,
    options: { getConsumerStuck: () => [] } as never,
    runtimeState: {
      getLifecycle: () => 'running',
      getStartedAt: () => Date.now(),
      components: { list: () => [] },
    } as never,
    lifecycleController: () => null,
    strictHealthIdentity: { ok: false } as never,
    strictHealthBundleDir: null,
    readSelfIncarnation: () => null,
    kbDaemonSupervisor: { read: () => ({}) } as never,
    settlementRefusalRecordingFailures: new Map(),
    providerOperationAdoptionRefusals: new Map(),
    readIpcOpenSockets: () => 0,
    eventStreamResponseCount: () => 0,
    launchPermitReportAgeMs: 30000,
    providerOperationStartupStatus: () => startup,
  });
  const snapshot = read();
  const frame = JSON.stringify({ kind: 'response', id: 1, result: snapshot }) + '\n';
  expect(snapshot.diagnostics?.providerOperationStartupReconciliation?.sets).toHaveLength(Math.min(setCount, 20));
  expect(snapshot.diagnostics?.providerOperationStartupReconciliation?.setCount).toBe(setCount);
  expect(Buffer.byteLength(frame)).toBeLessThan(64 * 1024);
  writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify({ pid: process.pid, bootToken: 'test-token' }));
  const server = createServer((socket) =>
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString().trim());
      const result =
        request.method === 'transport.ping'
          ? {
              status: snapshot.status,
              version: snapshot.version,
              bundleHash: snapshot.bundleHash,
              flavor: snapshot.flavor,
              namespace: snapshot.namespace,
              instanceId: snapshot.instanceId,
              pid: snapshot.pid,
              jobsWaitExtensions: [],
            }
          : snapshot;
      if (reply === 'malformed') socket.end('{\n');
      else if (reply === 'truncated') socket.end('{');
      else
        socket.end(
          JSON.stringify({
            kind: 'response',
            id: request.id,
            result: {
              ...result,
              ...(reply === 'oversized' ? { padding: 'x'.repeat(70 * 1024) } : {}),
              ...(reply === 'wrong-pid' ? { pid: process.pid + 1 } : {}),
              ...(reply === 'starting' ? { status: 'starting' } : {}),
              ...(reply === 'invalid-status' ? { status: 'future-status' } : {}),
            },
          }) + '\n',
        );
    }),
  );
  await new Promise<void>((resolve) =>
    server.listen(socketPathForRunDir(runDir, 'prod', { platform: process.platform }), resolve),
  );
  const admittedAt = Date.now();
  const child = { pid: process.pid, incarnation: probeProcessIncarnation(process.pid)! };
  const build = { buildSetId: 'test-build', bundleHash: 'test-hash', flavor: 'prod' as const, version: '0.10.16' };
  publishLaunchAdmission(runDir, {
    version: 1,
    launchId: randomUUID(),
    child,
    parent: { pid: process.ppid, incarnation: probeProcessIncarnation(process.ppid)! },
    admittedAt,
    discoveredAt: admittedAt + 1,
    build,
    purpose: 'startup',
  });
  const record = new SupervisorLaunchMemory(
    runDir,
    { pid: process.pid + 100000, incarnation: child.incarnation },
    build.buildSetId,
  );
  const owner = { current: record.read().owner, lost: false, release: () => {} };
  const now = vi.spyOn(Date, 'now').mockReturnValue(admittedAt + SENTINEL_TIMING.lapseMs + 1);
  const realKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => (signal === 0 ? realKill(pid, 0) : true));
  try {
    const serving = await replacementServing(runDir, 'prod', process.pid);
    await reconcileInheritedChildren({
      record,
      owner,
      runDir,
      originalManifest: build as never,
      incarnation: child.incarnation,
      timing: SENTINEL_TIMING,
      startupBudgetMs: STARTUP_BUDGET_MS,
      lastInheritedRequest: new Map(),
      replacement: false,
      recoveryChallenge: undefined,
      repairBridge: null,
    });
    if (reply === 'starting') {
      expect(serving).toBe(false);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } else {
      expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(serving).toBe(reply === 'snapshot' ? true : 'unknown');
    }
  } finally {
    now.mockRestore();
    kill.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
