import { afterEach, expect, it, vi } from 'vitest';
import { main } from '#src/coordinator/bootstrap.js';
import { createCoordinatorHealthReader } from '#src/coordinator/composition/health-observation.js';
import { readRecentFailureDomainRefusals } from '#src/infra/failure-domain.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import * as CoordinatorLog from '#src/infra/coordinator-log.js';

vi.mock('#src/infra/failure-domain.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  inheritedFailureDomainRoot: () => ({ kind: 'placed', root: '/inherited' }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('reports timestamped coordinator-observed refusal history and its observation limits only in health diagnostics', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  const inherited = {
    operation: 'create',
    subject: 'coordinator-test',
    errno: 'EACCES',
    observedAt: 1_600_000_000_000,
  } as const;
  vi.stubEnv('CORAL_FAILURE_DOMAIN_REFUSALS', JSON.stringify([inherited]));
  vi.stubEnv('CORAL_FAILURE_DOMAIN', '/inherited/coordinator-test');
  vi.stubEnv('CORAL_KB_DAEMON', '0');
  vi.stubGlobal('__PLUGIN_ROOT__', undefined);
  const argv = process.argv;
  try {
    process.argv = [process.execPath, 'coordinator-test'];
    await expect(main()).rejects.toThrow('bootstrap requires __PLUGIN_ROOT__');
  } finally {
    process.argv = argv;
  }
  expect(process.env.CORAL_FAILURE_DOMAIN_REFUSALS).toBeUndefined();
  expect(process.env.CORAL_FAILURE_DOMAIN).toBeUndefined();

  const coordinatorLogPath = '/state/coordinator-logs/serving-writer/current.log';
  const logPath = vi.spyOn(CoordinatorLog, 'getCoordinatorLogPath').mockReturnValue(coordinatorLogPath);
  const runtime = new SimulationRuntime();
  Object.defineProperty(runtime.process, 'failureDomainRoot', {
    value: { kind: 'placed', root: '/inherited' },
  });
  runtime.process.readRecentFailureDomainRefusals = readRecentFailureDomainRefusals;
  const input = {
    runtime,
    world: {
      identity: {
        version: 'test',
        bundleHash: 'test',
        flavor: 'prod',
        namespace: 'test',
        instanceId: 'test',
        now: () => 0,
      },
      backendPid: 123,
      coralEnvSnapshot: {
        CORAL_CODEX_MODEL: 'test-model',
        CORAL_FAILURE_DOMAIN_ROOT: '/inherited',
        CORAL_FAILURE_DOMAIN_REFUSALS: JSON.stringify([inherited]),
      },
      storeServicesRef: { tryGet: () => null },
      idleTimer: { isDraining: false, inflightRequests: 0 },
      providerProxyLifecycleRef: { get: () => null },
      discussRegistry: { contexts: new Map() },
      launchCoordinator: {
        active: 0,
        queueDepth: () => 0,
        activeLaunchPermits: () => [],
        launchReleaseDiagnostics: () => [],
        launchReclamationDiagnostics: () => [],
      },
    },
    options: {},
    runtimeState: {
      getLifecycle: () => 'starting',
      getStartedAt: () => 0,
      components: { list: () => [] },
    },
    lifecycleController: () => null,
    strictHealthIdentity: { ok: false },
    strictHealthBundleDir: null,
    readSelfIncarnation: () => null,
    kbDaemonSupervisor: { read: () => ({ status: 'offline' }) },
    settlementRefusalRecordingFailures: new Map(),
    providerOperationAdoptionRefusals: new Map(),
    readIpcOpenSockets: () => 0,
    eventStreamResponseCount: () => 0,
    launchPermitReportAgeMs: 0,
    providerOperationStartupStatus: () => null,
  } as unknown as Parameters<typeof createCoordinatorHealthReader>[0];
  const readHealth = createCoordinatorHealthReader(input);
  const health = readHealth();
  expect(health.diagnostics?.coordinatorLogPath).toBe(coordinatorLogPath);
  expect(readHealth.readLiveness()).not.toHaveProperty('diagnostics');
  logPath.mockReturnValue(undefined);
  expect(readHealth().diagnostics).not.toHaveProperty('coordinatorLogPath');
  expect(health.diagnostics?.hostPressure).toEqual({ kind: 'unobservable', reason: 'simulation' });
  runtime.process.readHostPressure = () => ({ kind: 'pressured', signal: 'io', reading: 'full avg10=12' });
  expect(createCoordinatorHealthReader(input)().diagnostics?.hostPressure).toEqual({
    kind: 'pressured',
    signal: 'io',
    reading: 'full avg10=12',
  });
  expect(health.diagnostics?.failureDomainRoot).toEqual({ kind: 'placed', root: '/inherited' });
  expect(health.diagnostics?.coordinatorObservedFailureDomainRefusalHistory?.entries).toEqual(
    expect.arrayContaining([
      inherited,
      { operation: 'enter', subject: '/inherited/coordinator-test', errno: 'EPERM', observedAt: 1_700_000_000_000 },
    ]),
  );
  expect(health.env).toEqual({ CORAL_CODEX_MODEL: 'test-model' });
  expect(health.status).toBe('starting');
  expect(health.diagnostics?.coordinatorObservedFailureDomainRefusalHistory?.unobservedOutcomes).toEqual([
    'role-entry',
    'payload-entry',
    'remote-role-leaf-creation',
    'remote-host-leaf-creation',
  ]);
  runtime.process.readRecentFailureDomainRefusals = () => [];
  expect(createCoordinatorHealthReader(input)().diagnostics?.coordinatorObservedFailureDomainRefusalHistory).toEqual({
    entries: [],
    unobservedOutcomes: ['role-entry', 'payload-entry', 'remote-role-leaf-creation', 'remote-host-leaf-creation'],
  });
});
