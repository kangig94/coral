import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import { GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE } from '#src/provider-proxy/protocol.js';
import {
  GuardianConstructionCleanupHeldError,
  startProviderGuardianRole,
  runProviderRoleMain,
} from '#src/provider-proxy/role-main.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const state = vi.hoisted(() => ({
  beforeProxy: false,
  close: async () => {},
  failure: new Error('guardian construction interposed failure'),
}));
vi.mock('#src/provider-proxy/bootstrap-capsule.js', async (original) => ({
  ...(await original<object>()),
  consumeProviderBootstrapCapsule: () => ({
    role: 'guardian',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: '11111111-1111-4111-8111-111111111111',
    hostFingerprint: 'b'.repeat(64),
    guardianInstanceId: '22222222-2222-4222-8222-222222222222',
    reaperInstanceId: '33333333-3333-4333-8333-333333333333',
    proxyInstanceId: '44444444-4444-4444-8444-444444444444',
    bootstrapNonce: 'a'.repeat(64),
    canonicalControlEndpoint: '/guardian.sock',
    reaperControlEndpoint: '/reaper.sock',
    proxyEndpoint: '/proxy.sock',
    guardianReaperAuthSecret: 'c'.repeat(64),
    proxyGuardianAuthSecret: 'd'.repeat(64),
  }),
}));
vi.mock('#src/provider-proxy/role-spawn.js', async (original) => ({
  ...(await original<object>()),
  spawnRoleProcess: (role: string) => {
    const pid = role === 'proxy' ? 7100 : 7200;
    const child = Object.assign(new EventEmitter(), {
      pid,
      exitCode: 0,
      signalCode: null,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: () => true,
      unref: () => {},
    }) satisfies ChildProcessLike;
    return {
      kind: 'spawned',
      child,
      pid,
      incarnation: testIncarnation(pid),
      spawnFailed: new Promise<never>(() => {}),
    };
  },
  connectRoleControlWithRetry: async () => ({
    exchange: async () =>
      controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: { state: 'paired' } } }),
    close: () => {},
  }),
}));
vi.mock('#src/provider-proxy/guardian.js', async (original) => ({
  ...(await original<object>()),
  createGuardian: () => ({
    listen: async () => {
      if (state.beforeProxy) throw state.failure;
    },
    close: () => state.close(),
    recordContainment: async () => {
      throw state.failure;
    },
    enforcer: () => null,
  }),
}));
let stdoutListeners = new Set(process.stdout.listeners('error'));
let stderrListeners = new Set(process.stderr.listeners('error'));
beforeEach(() => {
  stdoutListeners = new Set(process.stdout.listeners('error'));
  stderrListeners = new Set(process.stderr.listeners('error'));
  state.beforeProxy = false;
  state.close = async () => {};
});
afterEach(() => {
  for (const listener of process.stdout.listeners('error'))
    if (!stdoutListeners.has(listener)) process.stdout.removeListener('error', listener as (error: Error) => void);
  for (const listener of process.stderr.listeners('error'))
    if (!stderrListeners.has(listener)) process.stderr.removeListener('error', listener as (error: Error) => void);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  ['populated', 'core-final'],
  ['missing', 'core-final'],
  ['unknown', 'core-final'],
  ['populated', 'unwind-final'],
  ['missing', 'unwind-final'],
  ['unknown', 'unwind-final'],
  ['populated', 'before-proxy'],
  ['missing', 'before-proxy'],
  ['unknown', 'before-proxy'],
] as const)('retains construction cleanup when leaf becomes %s during %s', async (kind, stage) => {
  const runtime = new SimulationRuntime();
  let observation: FailureDomainObservation = { kind: 'absent' };
  let exactTargetObserved = false;
  let ordinaryReaperObserved = false;
  let interposed = false;
  const transition = () => {
    observation = kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind };
  };
  state.beforeProxy = stage === 'before-proxy';
  if (state.beforeProxy)
    state.close = async () => {
      transition();
      interposed = true;
    };
  vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
  vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation((pid) => {
    if (pid === 7200) {
      ordinaryReaperObserved = true;
      return testIncarnation(7201);
    }
    return pid === runtime.env.pid() ? testIncarnation(pid) : null;
  });
  vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((pid) => {
    if (pid === 7200) ordinaryReaperObserved = true;
    return 'absent';
  });
  vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
    observe: () => {
      if (
        !interposed &&
        ((stage === 'core-final' && exactTargetObserved) || (stage === 'unwind-final' && ordinaryReaperObserved))
      ) {
        interposed = true;
        queueMicrotask(transition);
      }
      return observation;
    },
    kill: () => ({ kind: 'refused', errno: 'EACCES' }),
  });
  const failure = await startProviderGuardianRole('/unused', {
    runtime,
    pluginRoot: '/plugin',
    baseDir: '/test',
    exitProcess: vi.fn(),
    observeRecordedProcessAsync: async () => {
      exactTargetObserved = true;
      return 'absent';
    },
  }).catch((error: unknown) => error);
  expect(interposed).toBe(true);
  expect(failure).toBeInstanceOf(GuardianConstructionCleanupHeldError);
  if (!(failure instanceof GuardianConstructionCleanupHeldError))
    throw new Error('Expected retained construction cleanup');
  expect(failure.hold.pending.length).toBeGreaterThan(0);
  observation = { kind: 'missing' };
  expect((await failure.hold.retry()).kind).toBe('holding');
});

it.each([false, true])(
  'preserves settled construction cleanup with an empty existing leaf (before proxy: %s)',
  async (beforeProxy) => {
    const runtime = new SimulationRuntime();
    state.beforeProxy = beforeProxy;
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation((pid) =>
      testIncarnation(pid === 7200 ? 7201 : pid),
    );
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('absent');
    vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
      observe: () => ({ kind: 'absent' }),
      kill: () => ({ kind: 'entered' }),
    });
    await expect(
      startProviderGuardianRole('/unused', {
        runtime,
        pluginRoot: '/plugin',
        baseDir: '/test',
        exitProcess: vi.fn(),
        observeRecordedProcessAsync: async () => 'absent',
      }),
    ).rejects.toBe(state.failure);
  },
);

it.each(['populated', 'missing', 'unknown', 'absent'] as const)(
  'checks the same proof after awaited construction retry before returning the settled exit code (%s)',
  async (kind) => {
    const runtime = new SimulationRuntime();
    let observation: FailureDomainObservation = { kind: 'populated' };
    let exactTargetObserved = false;
    let postTargetObservations = 0;
    let transitions = 0;
    vi.stubEnv('CORAL_CUSTODY_PROCESS_TICKET', undefined);
    vi.stubEnv('CORAL_CUSTODY_EPOCH', undefined);
    vi.stubEnv('CORAL_CUSTODY_EPOCH_KEY', undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Unexpected process exit');
    });
    vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation((pid) =>
      testIncarnation(pid === 7200 ? 7201 : pid),
    );
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('absent');
    Object.defineProperty(runtime.process, 'observeRecordedProcessAsync', {
      value: async () => {
        exactTargetObserved = true;
        return 'absent' as const;
      },
    });
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async () => {
      observation = { kind: 'absent' };
      exactTargetObserved = false;
      postTargetObservations = 0;
    });
    vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
      observe: () => {
        if (exactTargetObserved && ++postTargetObservations === 3) {
          transitions += 1;
          queueMicrotask(() => {
            observation = kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind };
          });
        }
        return observation;
      },
      kill: () => ({ kind: 'refused', errno: 'EACCES' }),
    });
    const code = await runProviderRoleMain(
      { role: 'guardian', capsulePath: '/unused' },
      { runtime, pluginRoot: '/plugin' },
    );
    expect(transitions).toBeGreaterThan(0);
    if (kind === 'absent') expect(code).toBe(GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE);
    else expect(code).toBe(1);
    expect(process.exit).not.toHaveBeenCalled();
  },
);
