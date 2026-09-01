import { isProcessIncarnation, type ProcessLiveness } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  bindWithHandoff,
  createFileHandoffSignalLedger,
  HandoffEscalationError,
  registerCoordinatorStartupRecovery,
  type BoundCoordinator,
  type HandoffBindResult,
  type HandoffOptions,
  type HandoffSignalCooldownDisposition,
  type HandoffSignalLedger,
  type HandoffSignalPolicy,
} from '#src/coordinator/handoff.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { CoralSetupError, type HandoffRefusalCode, type HandoffRefusalContextByCode } from '#src/runtime/errors.js';
import type { IdPort } from '#src/runtime/ports.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { Runtime } from '#src/runtime/ports.js';
import { IncumbentMatchesError, type IncumbentHealth, type IncumbentIdentity } from '#src/transport/ipc/handoff.js';
import { backendLog } from '#src/infra/backend-log.js';

vi.mock('#src/transport/ipc/handoff.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    requestIncumbentShutdown: vi.fn(),
  };
});

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    probeProcessIncarnation: vi.fn(),
  };
});

import { requestIncumbentShutdown } from '#src/transport/ipc/handoff.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';

const mockedShutdown = requestIncumbentShutdown as ReturnType<typeof vi.fn>;
const mockedProbe = vi.mocked(probeProcessIncarnation);

interface KillCall {
  pid: number;
  signal: NodeJS.Signals | 0;
}

function buildHarness(opts?: {
  bindAttempt?: HandoffOptions['bindAttempt'];
  bindSequence?: HandoffBindResult[];
  totalBudgetMs?: number;
  observeLiveness?: (pid: number, killAttempted: boolean, killCalls: readonly KillCall[]) => ProcessLiveness;
  killReturns?: (signal: NodeJS.Signals | 0) => boolean;
  killThrows?: boolean;
  readDiscovery?: HandoffOptions['readVerifiedIncumbentFromDiscovery'];
  signalLedger?: HandoffSignalLedger;
  signalCooldownMs?: number;
  signalPolicy?: HandoffSignalPolicy;
  signal?: AbortSignal;
  runStartupRecovery?: HandoffOptions['runStartupRecovery'];
  platform?: NodeJS.Platform;
}) {
  const time = new VirtualTime();
  const killCalls: KillCall[] = [];
  let killAttempted = false;
  const observeLiveness = opts?.observeLiveness ?? ((): ProcessLiveness => 'alive');
  const observeLivenessImpl = (pid: number): ProcessLiveness => observeLiveness(pid, killAttempted, killCalls);
  const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
    time,
    process: {
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        killCalls.push({ pid, signal });
        killAttempted = true;
        if (opts?.killThrows) {
          throw new Error('kill failed');
        }
        return opts?.killReturns?.(signal) ?? true;
      },
      observeLiveness: observeLivenessImpl,
      readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => mockedProbe(pid, platform),
    } as unknown as Runtime['process'],
    env: {
      platform: () => opts?.platform ?? 'linux',
    } as unknown as Runtime['env'],
  };

  let bindIndex = 0;
  const bindSequence = opts?.bindSequence ?? [{ kind: 'incumbent', reason: 'live-listener' }];
  const bindAttempt =
    opts?.bindAttempt ??
    vi.fn(async () => {
      const idx = Math.min(bindIndex, bindSequence.length - 1);
      bindIndex += 1;
      return bindSequence[idx];
    });

  const readDiscovery: HandoffOptions['readVerifiedIncumbentFromDiscovery'] = opts?.readDiscovery ?? (() => null);

  const options: HandoffOptions = {
    socketPath: '/tmp/coral.sock',
    desired: { version: '0.9.1', bundleHash: 'new-hash', flavor: 'prod', namespace: 'ns' },
    bindAttempt,
    runStartupRecovery: opts?.runStartupRecovery ?? (async () => []),
    runtime,
    readVerifiedIncumbentFromDiscovery: readDiscovery,
    ...(opts?.signalLedger === undefined ? {} : { signalLedger: opts.signalLedger }),
    ...(opts?.signalCooldownMs === undefined ? {} : { signalCooldownMs: opts.signalCooldownMs }),
    ...(opts?.signalPolicy === undefined ? {} : { signalPolicy: opts.signalPolicy }),
    ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    totalBudgetMs: opts?.totalBudgetMs ?? 30_000,
  };

  return { time, runtime, options, killCalls, bindAttempt };
}

const flush = async (rounds = 16): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

const pendingSignalFailureCases = [
  ['SIGTERM', 'gone'],
  ['SIGTERM', 'alive'],
  ['SIGTERM', 'unverifiable'],
  ['SIGKILL', 'gone'],
  ['SIGKILL', 'alive'],
  ['SIGKILL', 'unverifiable'],
] as const;

function shutdownResult(overrides: {
  health?: IncumbentHealth | null;
  verifiedIdentity?: IncumbentIdentity | null;
  shutdownAttempted?: boolean;
  shutdownUnauthorized?: boolean;
}) {
  return {
    health: null,
    verifiedIdentity: null,
    shutdownAttempted: true,
    shutdownUnauthorized: false,
    ...overrides,
  };
}

function expectHandoffRefusal<Code extends HandoffRefusalCode>(
  outcome: unknown,
  code: Code,
  context: HandoffRefusalContextByCode[Code],
  cause?: unknown,
): HandoffEscalationError {
  expect(outcome).toBeInstanceOf(HandoffEscalationError);
  expect(outcome).toBeInstanceOf(CoralSetupError);
  expect(outcome).toMatchObject({ code, context });
  if (arguments.length === 4) {
    expect((outcome as Error).cause).toBe(cause);
  }
  return outcome as HandoffEscalationError;
}

function shippedV0109IsHandoffSignalRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.socketPath === 'string' &&
    Number.isInteger(record.pid) &&
    (record.incarnation === undefined || isProcessIncarnation(record.incarnation)) &&
    (record.instanceId === undefined || typeof record.instanceId === 'string') &&
    (record.signal === 'SIGTERM' || record.signal === 'SIGKILL') &&
    Number.isFinite(record.signaledAtMs)
  );
}

function shippedV0109CooldownApplies(
  value: unknown,
  socketPath: string,
  incumbent: IncumbentIdentity,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (!shippedV0109IsHandoffSignalRecord(value)) {
    return false;
  }
  const record = value as {
    socketPath: string;
    pid: number;
    incarnation?: string;
    instanceId?: string;
    signaledAtMs: number;
  };
  const sameTarget =
    record.socketPath === socketPath &&
    record.pid === incumbent.pid &&
    (record.incarnation === undefined ||
      incumbent.incarnation === undefined ||
      record.incarnation === incumbent.incarnation) &&
    (record.instanceId === undefined || record.instanceId === incumbent.instanceId);
  return sameTarget && nowMs - record.signaledAtMs < cooldownMs;
}

beforeEach(() => {
  mockedShutdown.mockReset();
  mockedProbe.mockReset();
});

const ledgerTempRoots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of ledgerTempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function durableLedgerDisposition(input: {
  detail?: unknown;
  shadow?: unknown;
  nowMs: number;
  cooldownMs?: number;
}): HandoffSignalCooldownDisposition {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-handoff-ledger-'));
  ledgerTempRoots.push(runDir);
  if (input.detail !== undefined) {
    writeFileSync(join(runDir, 'handoff-signal.v2.json'), `${JSON.stringify(input.detail)}\n`, 'utf-8');
  }
  if (input.shadow !== undefined) {
    writeFileSync(join(runDir, 'handoff-signal.json'), `${JSON.stringify(input.shadow)}\n`, 'utf-8');
  }
  const storage = {
    readFileSync,
    mkdirSync,
    writeAtomicSync: writeFileSync,
  } as unknown as Parameters<typeof createFileHandoffSignalLedger>[0]['storage'];
  return createFileHandoffSignalLedger({ storage, ids: countingIds(), runDir }).cooldownDisposition({
    socketPath: '/tmp/coral.sock',
    incumbent: {
      pid: 2467,
      incarnation: testIncarnation(899),
      instanceId: 'same-incumbent',
      source: 'discovery',
    },
    nowMs: input.nowMs,
    cooldownMs: input.cooldownMs ?? 60_000,
  });
}

/** Sequential rather than random so a test can say which publication is newer without reading a clock. */
function countingIds(): IdPort {
  let issued = 0;
  return {
    uuid: () => `00000000-0000-4000-8000-${String(++issued).padStart(12, '0')}`,
    randomBytes: (size: number) => Buffer.alloc(size),
    sha256: () => 'sha256',
  };
}

describe('bindWithHandoff', () => {
  it('preserves subclass, base-class, and direct cause identity', () => {
    const cause = new Error('private bind failure');
    const error = new HandoffEscalationError(
      {
        code: 'handoff_accepted_signal_target_alive_after_failure',
        context: { stage: 'after-accepted-signal-failure', pid: 4242, signal: 'SIGTERM' },
      },
      { cause },
    );

    expectHandoffRefusal(
      error,
      'handoff_accepted_signal_target_alive_after_failure',
      { stage: 'after-accepted-signal-failure', pid: 4242, signal: 'SIGTERM' },
      cause,
    );
  });

  it('happy path: first bind attempt succeeds → no incumbent observed', async () => {
    const { options, time, bindAttempt } = buildHarness({
      bindSequence: [{ kind: 'bound' }],
    });
    const before = time.now();
    const result = await bindWithHandoff(options);
    expect(result.acquiredViaHandoff).toBe(false);
    expect(bindAttempt).toHaveBeenCalledTimes(1);
    expect(mockedShutdown).not.toHaveBeenCalled();
    expect(time.now()).toBe(before);
  });

  it('moves the handoff channel to the exact published socket reported by the binder', async () => {
    const publishedSocketPath = '/launcher-specific/coral-prod-shipped.sock';
    const verifiedIdentity: IncumbentIdentity = {
      pid: 4242,
      incarnation: testIncarnation(1_000_000),
      source: 'discovery',
      instanceId: 'shipped-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const readDiscovery = vi.fn(() => verifiedIdentity);
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'addressed-incumbent', socketPath: publishedSocketPath }, { kind: 'bound' }],
      readDiscovery,
    });
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old',
          flavor: 'prod',
          namespace: 'ns',
          pid: verifiedIdentity.pid,
          incarnation: verifiedIdentity.incarnation,
        },
        verifiedIdentity,
      }),
    );
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const result = bindWithHandoff(options);
    await flush();
    time.tick(200);
    await expect(result).resolves.toMatchObject({ acquiredViaHandoff: true });

    expect(mockedShutdown).toHaveBeenCalledWith(expect.objectContaining({ socketPath: publishedSocketPath }));
    expect(readDiscovery).toHaveBeenCalledWith(expect.objectContaining({ socketPath: publishedSocketPath }));
  });

  it('runs startup recovery only after the real bound capability registers its coordinator runner', async () => {
    const runCoordinatorStartupRecovery = vi.fn(async () => ({}) as never);
    const runStartupRecovery = vi.fn(async (_inputs, runJobsStartup) => {
      await runJobsStartup({} as never);
      return [];
    });
    const { options } = buildHarness({
      bindSequence: [{ kind: 'bound' }],
      runStartupRecovery,
    });
    const bound = await bindWithHandoff(options);

    expect(() => bound.runStartupRecovery({} as never)).toThrow('Bound coordinator startup recovery is not registered');

    registerCoordinatorStartupRecovery(bound, runCoordinatorStartupRecovery);
    await expect(bound.runStartupRecovery({} as never)).resolves.toEqual([]);
    expect(runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(runCoordinatorStartupRecovery).toHaveBeenCalledTimes(1);
  });

  it('rejects a structurally forged bound coordinator at the consumed boundary', () => {
    const forged: BoundCoordinator = {
      acquiredViaHandoff: false,
      runStartupRecovery: async () => [],
    };

    expect(() => registerCoordinatorStartupRecovery(forged, async () => ({}) as never)).toThrow(
      'Bound coordinator capability is not registered',
    );
  });

  it('same-bundle incumbent throws IncumbentMatchesError', async () => {
    const { options } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
    });
    mockedShutdown.mockImplementationOnce(() => {
      throw new IncumbentMatchesError(options.desired);
    });
    await expect(bindWithHandoff(options)).rejects.toBeInstanceOf(IncumbentMatchesError);
  });

  it('mismatched bundle: requests shutdown, polls bind, succeeds', async () => {
    const { options, time } = buildHarness({
      bindSequence: [
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'bound' },
      ],
    });
    const verifiedIdentity: IncumbentIdentity = {
      pid: 4242,
      incarnation: testIncarnation(1_000_000),
      source: 'health',
    };
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old',
          flavor: 'prod',
          namespace: 'ns',
          pid: 4242,
          incarnation: testIncarnation(1_000_000),
        } as IncumbentHealth,
        verifiedIdentity,
      }),
    );
    const promise = bindWithHandoff(options);
    // Poll cycles: each iteration sleeps `SOCKET_BIND_POLL_MS` (200).
    for (let i = 0; i < 5; i += 1) {
      await flush();
      time.tick(200);
    }
    await flush();
    const result = await promise;
    expect(result.acquiredViaHandoff).toBe(true);
    expect(mockedShutdown).toHaveBeenCalled();
  });

  it('cutover handoff: mismatched incumbent with discovery boot credential self-completes', async () => {
    const discoveryIdentity: IncumbentIdentity = {
      pid: 5252,
      incarnation: testIncarnation(7_000),
      source: 'discovery',
      instanceId: 'cutover-incumbent',
      token: 'backend-token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
      readDiscovery: () => discoveryIdentity,
    });
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old-hash',
          flavor: 'prod',
          namespace: 'ns',
          status: 'ok',
          pid: discoveryIdentity.pid,
          incarnation: discoveryIdentity.incarnation,
          instanceId: discoveryIdentity.instanceId,
        },
        verifiedIdentity: null,
        shutdownAttempted: true,
        shutdownUnauthorized: false,
      }),
    );

    const promise = bindWithHandoff(options);
    await flush();
    time.tick(200);
    await flush();

    await expect(promise).resolves.toEqual({
      acquiredViaHandoff: true,
      runStartupRecovery: expect.any(Function),
    });
    expect(mockedShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: '/tmp/coral.sock',
        desired: options.desired,
        bootToken: 'boot-token',
      }),
    );
  });

  it('cutover handoff: mismatched incumbent without a discovery boot credential names its successor', async () => {
    const discoveryIdentity: IncumbentIdentity = {
      pid: 5353,
      incarnation: testIncarnation(7_100),
      source: 'discovery',
      instanceId: 'cutover-incumbent-no-credential',
      token: 'backend-token',
      shutdownToken: 'shutdown-token',
    };
    const { options } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      readDiscovery: () => discoveryIdentity,
    });
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old-hash',
          flavor: 'prod',
          namespace: 'ns',
          status: 'ok',
          pid: discoveryIdentity.pid,
          incarnation: discoveryIdentity.incarnation,
          instanceId: discoveryIdentity.instanceId,
        },
        verifiedIdentity: null,
        shutdownAttempted: false,
        shutdownUnauthorized: false,
      }),
    );

    const outcome = await bindWithHandoff(options).catch((error: Error) => error);

    expectHandoffRefusal(outcome, 'handoff_shutdown_credential_unavailable', {
      stage: 'shutdown-request',
      pid: 5353,
    });
    expect(mockedShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: '/tmp/coral.sock',
        desired: options.desired,
        bootToken: undefined,
      }),
    );
  });

  it('a rejected shutdown capability names how to stop the socket owner', async () => {
    const discoveryIdentity: IncumbentIdentity = {
      pid: 5454,
      incarnation: testIncarnation(7_200),
      source: 'discovery',
      instanceId: 'capability-rejected',
      token: 'backend-token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const { options } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      readDiscovery: () => discoveryIdentity,
    });
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: null,
        verifiedIdentity: discoveryIdentity,
        shutdownUnauthorized: true,
      }),
    );

    const outcome = await bindWithHandoff(options).catch((error: Error) => error);

    expectHandoffRefusal(outcome, 'handoff_shutdown_capability_rejected', {
      stage: 'shutdown-request',
      pid: 5454,
    });
  });

  it('budget exhausted with no verified pid → HandoffEscalationError', async () => {
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));

    const promise = bindWithHandoff(options).catch((error: Error) => error);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(100);
    }
    await flush();
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_socket_holder_unverified', {
      stage: 'handoff-deadline',
      socketPath: '/tmp/coral.sock',
    });
  });

  it('reports an observed-live incumbent after SIGKILL grace', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7777,
      incarnation: testIncarnation(555_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-a',
        token: 'token-a',
        bootToken: 'boot-token-a',
        shutdownToken: 'shutdown-token-a',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(testIncarnation(555_000)); // matched

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 5; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_sigkill_grace_target_alive', {
      stage: 'after-sigkill-grace',
      pid: 7777,
      signal: 'SIGKILL',
      graceMs: SIGKILL_GRACE_MS,
    });
    const sigterms = killCalls.filter((c) => c.signal === 'SIGTERM');
    const sigkills = killCalls.filter((c) => c.signal === 'SIGKILL');
    expect(sigterms.length).toBeGreaterThanOrEqual(1);
    expect(sigkills.length).toBeGreaterThanOrEqual(1);
    expect(sigterms[0].pid).toBe(7777);
  });

  it('reports a socket anomaly only when the incumbent is observed gone after SIGKILL grace', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7778,
      incarnation: testIncarnation(556_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: (_pid, _killAttempted, killCalls) =>
        killCalls.some((call) => call.signal === 'SIGKILL') ? 'absent' : 'alive',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-gone',
        token: 'token-gone',
        bootToken: 'boot-token-gone',
        shutdownToken: 'shutdown-token-gone',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValue(null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 5; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expectHandoffRefusal(outcome, 'handoff_sigkill_grace_target_gone_socket_still_bound', {
      stage: 'after-sigkill-grace',
      pid: 7778,
      signal: 'SIGKILL',
      graceMs: SIGKILL_GRACE_MS,
    });
    expect(killCalls.filter((call) => call.signal === 'SIGKILL')).toHaveLength(1);
  });

  it('reports an indeterminate outcome when the final target identity cannot be verified', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7779,
      incarnation: testIncarnation(557_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: (_pid, _killAttempted, killCalls) =>
        killCalls.some((call) => call.signal === 'SIGKILL') ? 'unknown' : 'alive',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-unknown',
        token: 'token-unknown',
        bootToken: 'boot-token-unknown',
        shutdownToken: 'shutdown-token-unknown',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValue(null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 5; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_process_identity_unavailable', {
      stage: 'after-sigkill-grace',
      pid: 7779,
      signal: 'SIGKILL',
      graceMs: SIGKILL_GRACE_MS,
    });
    expect(killCalls.filter((call) => call.signal === 'SIGKILL')).toHaveLength(1);
  });

  it('reports a live target after rejection without recording a signal or arming a grace', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7780,
      incarnation: testIncarnation(558_000),
      source: 'health',
    };
    const signalLedger: HandoffSignalLedger = { cooldownDisposition: () => ({ kind: 'clear' }), write: vi.fn() };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      killReturns: () => false,
      signalLedger,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-signal-rejected',
        token: 'token-signal-rejected',
        bootToken: 'boot-token-signal-rejected',
        shutdownToken: 'shutdown-token-signal-rejected',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((error: Error) => error);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expectHandoffRefusal(outcome, 'handoff_signal_rejected_live', {
      stage: 'after-rejected-signal',
      pid: 7780,
      signal: 'SIGTERM',
    });
    expect(killCalls).toEqual([{ pid: 7780, signal: 'SIGTERM' }]);
    expect(signalLedger.write).not.toHaveBeenCalled();
  });

  it('reports a rejected signal separately when the target cannot be re-observed', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7781,
      incarnation: testIncarnation(559_000),
      source: 'health',
    };
    const signalLedger: HandoffSignalLedger = { cooldownDisposition: () => ({ kind: 'clear' }), write: vi.fn() };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      killReturns: () => false,
      observeLiveness: (_pid, killAttempted) => (killAttempted ? 'unknown' : 'alive'),
      signalLedger,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-rejection-unverified',
        token: 'token-rejection-unverified',
        bootToken: 'boot-token-rejection-unverified',
        shutdownToken: 'shutdown-token-rejection-unverified',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValue(null);

    const promise = bindWithHandoff(options).catch((error: Error) => error);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_process_identity_unavailable', {
      stage: 'after-rejected-signal',
      pid: 7781,
      signal: 'SIGTERM',
    });
    expect(killCalls).toEqual([{ pid: 7781, signal: 'SIGTERM' }]);
    expect(signalLedger.write).not.toHaveBeenCalled();
  });

  it('retries binding without a ledger entry or grace when rejection is followed by observed absence', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7782,
      incarnation: testIncarnation(560_000),
      source: 'health',
    };
    const signalLedger: HandoffSignalLedger = { cooldownDisposition: () => ({ kind: 'clear' }), write: vi.fn() };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [
        ...Array.from({ length: 8 }, () => ({ kind: 'incumbent', reason: 'live-listener' }) as const),
        { kind: 'bound' },
      ],
      totalBudgetMs: 1_000,
      killReturns: () => false,
      observeLiveness: (_pid, killAttempted): ProcessLiveness => (killAttempted ? 'absent' : 'alive'),
      signalLedger,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-gone-after-rejection',
        token: 'token-gone-after-rejection',
        bootToken: 'boot-token-gone-after-rejection',
        shutdownToken: 'shutdown-token-gone-after-rejection',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValue(null);

    const promise = bindWithHandoff(options);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }

    await expect(promise).resolves.toMatchObject({ acquiredViaHandoff: true });
    expect(killCalls).toEqual([{ pid: 7782, signal: 'SIGTERM' }]);
    expect(signalLedger.write).not.toHaveBeenCalled();
  });

  it('records accepted SIGTERM but not rejected SIGKILL', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7783,
      incarnation: testIncarnation(561_000),
      source: 'health',
    };
    const signalLedger: HandoffSignalLedger = { cooldownDisposition: () => ({ kind: 'clear' }), write: vi.fn() };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      killReturns: (signal) => signal === 'SIGTERM',
      signalLedger,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-sigkill-rejected',
        token: 'token-sigkill-rejected',
        bootToken: 'boot-token-sigkill-rejected',
        shutdownToken: 'shutdown-token-sigkill-rejected',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((error: Error) => error);
    for (let i = 0; i < (SIGTERM_GRACE_MS + 3_000) / 200; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expectHandoffRefusal(outcome, 'handoff_signal_rejected_live', {
      stage: 'after-rejected-signal',
      pid: 7783,
      signal: 'SIGKILL',
    });
    expect(killCalls).toEqual([
      { pid: 7783, signal: 'SIGTERM' },
      { pid: 7783, signal: 'SIGKILL' },
    ]);
    expect(signalLedger.write).toHaveBeenCalledTimes(1);
    expect(signalLedger.write).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, accepted: true, signal: 'SIGTERM' }),
    );
  });

  it.each(pendingSignalFailureCases)(
    'observes an accepted %s before a bind error exits when the target is %s',
    async (acceptedSignal, targetStatus) => {
      const proximateError = new Error('bind probe failed');
      const verifiedIdentity: IncumbentIdentity = {
        pid: 7787,
        incarnation: testIncarnation(557_000),
        source: 'health',
      };
      const acceptedSignals: NodeJS.Signals[] = [];
      const { options, time, killCalls } = buildHarness({
        bindAttempt: async () => {
          if (acceptedSignals.includes(acceptedSignal)) throw proximateError;
          return { kind: 'incumbent', reason: 'live-listener' };
        },
        totalBudgetMs: 500,
        observeLiveness: () => {
          if (!acceptedSignals.includes(acceptedSignal)) return 'alive';
          if (targetStatus === 'gone') return 'absent';
          return targetStatus === 'alive' ? 'alive' : 'unknown';
        },
        killReturns: (signal) => {
          if (signal !== 0) acceptedSignals.push(signal);
          return true;
        },
        readDiscovery: () => ({
          ...verifiedIdentity,
          source: 'discovery',
          instanceId: 'bind-error-incumbent',
          token: 'token',
          bootToken: 'boot-token',
          shutdownToken: 'shutdown-token',
        }),
      });
      mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
      mockedProbe.mockImplementation(() =>
        acceptedSignals.includes(acceptedSignal) && targetStatus === 'gone'
          ? null
          : (verifiedIdentity.incarnation ?? null),
      );

      const promise = bindWithHandoff(options).catch((error: unknown) => error);
      for (let i = 0; i < (SIGTERM_GRACE_MS + 5_000) / 200; i += 1) {
        await flush();
        time.tick(200);
      }
      const outcome = await promise;

      expect(killCalls).toEqual(
        acceptedSignal === 'SIGTERM'
          ? [{ pid: 7787, signal: 'SIGTERM' }]
          : [
              { pid: 7787, signal: 'SIGTERM' },
              { pid: 7787, signal: 'SIGKILL' },
            ],
      );
      if (targetStatus === 'gone') {
        expect(outcome).toBe(proximateError);
      } else if (targetStatus === 'alive') {
        expectHandoffRefusal(
          outcome,
          'handoff_accepted_signal_target_alive_after_failure',
          { stage: 'after-accepted-signal-failure', pid: 7787, signal: acceptedSignal },
          proximateError,
        );
      } else {
        expectHandoffRefusal(
          outcome,
          'handoff_process_liveness_unknown',
          { stage: 'after-accepted-signal-failure', pid: 7787, signal: acceptedSignal },
          proximateError,
        );
      }
    },
  );

  it.each(pendingSignalFailureCases)(
    'observes an accepted %s before a pending-poll failure exits when the target is %s',
    async (acceptedSignal, targetStatus) => {
      const proximateError = new Error('pending poll failed');
      const verifiedIdentity: IncumbentIdentity = {
        pid: 7786,
        incarnation: testIncarnation(558_000),
        source: 'health',
      };
      const acceptedSignals: NodeJS.Signals[] = [];
      const { options, time, killCalls } = buildHarness({
        bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
        totalBudgetMs: 500,
        observeLiveness: () => {
          if (!acceptedSignals.includes(acceptedSignal)) return 'alive';
          if (targetStatus === 'gone') return 'absent';
          return targetStatus === 'alive' ? 'alive' : 'unknown';
        },
        killReturns: (signal) => {
          if (signal !== 0) acceptedSignals.push(signal);
          return true;
        },
        readDiscovery: () => ({
          ...verifiedIdentity,
          source: 'discovery',
          instanceId: 'poll-error-incumbent',
          token: 'token',
          bootToken: 'boot-token',
          shutdownToken: 'shutdown-token',
        }),
      });
      const sleep = time.sleep.bind(time);
      vi.spyOn(time, 'sleep').mockImplementation(async (ms, sleepOptions) => {
        if (acceptedSignals.includes(acceptedSignal)) throw proximateError;
        await sleep(ms, sleepOptions);
      });
      mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
      mockedProbe.mockImplementation(() =>
        acceptedSignals.includes(acceptedSignal) && targetStatus === 'gone'
          ? null
          : (verifiedIdentity.incarnation ?? null),
      );

      const promise = bindWithHandoff(options).catch((error: unknown) => error);
      for (let i = 0; i < (SIGTERM_GRACE_MS + 5_000) / 200; i += 1) {
        await flush();
        time.tick(200);
      }
      const outcome = await promise;

      expect(killCalls).toEqual(
        acceptedSignal === 'SIGTERM'
          ? [{ pid: 7786, signal: 'SIGTERM' }]
          : [
              { pid: 7786, signal: 'SIGTERM' },
              { pid: 7786, signal: 'SIGKILL' },
            ],
      );
      if (targetStatus === 'gone') {
        expect(outcome).toBe(proximateError);
      } else if (targetStatus === 'alive') {
        expectHandoffRefusal(
          outcome,
          'handoff_accepted_signal_target_alive_after_failure',
          { stage: 'after-accepted-signal-failure', pid: 7786, signal: acceptedSignal },
          proximateError,
        );
      } else {
        expectHandoffRefusal(
          outcome,
          'handoff_process_liveness_unknown',
          { stage: 'after-accepted-signal-failure', pid: 7786, signal: acceptedSignal },
          proximateError,
        );
      }
    },
  );

  it.each(['gone', 'alive', 'unverifiable'] as const)(
    'settles an accepted signal when post-grace discovery fails and the target is %s',
    async (targetStatus) => {
      const discoveryError = Object.assign(new Error('coordinator discovery unreadable'), { code: 'EACCES' });
      const verifiedIdentity: IncumbentIdentity = {
        pid: 7784,
        incarnation: testIncarnation(560_000),
        source: 'health',
      };
      let sigtermAccepted = false;
      let discoveryFailed = false;
      const { options, time, killCalls } = buildHarness({
        bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
        totalBudgetMs: 500,
        observeLiveness: () => {
          if (!discoveryFailed) return 'alive';
          if (targetStatus === 'gone') return 'absent';
          return targetStatus === 'alive' ? 'alive' : 'unknown';
        },
        killReturns: (signal) => {
          sigtermAccepted = signal === 'SIGTERM';
          return true;
        },
        readDiscovery: () => {
          if (sigtermAccepted) {
            discoveryFailed = true;
            throw discoveryError;
          }
          return {
            ...verifiedIdentity,
            source: 'discovery',
            instanceId: 'post-grace-discovery-error-incumbent',
            token: 'token',
            bootToken: 'boot-token',
            shutdownToken: 'shutdown-token',
          };
        },
      });
      mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
      mockedProbe.mockImplementation(() =>
        discoveryFailed && targetStatus === 'gone' ? null : (verifiedIdentity.incarnation ?? null),
      );

      const promise = bindWithHandoff(options).catch((error: unknown) => error);
      for (let i = 0; i < (SIGTERM_GRACE_MS + 5_000) / 200; i += 1) {
        await flush();
        time.tick(200);
      }
      const outcome = await promise;

      expect(killCalls).toEqual([{ pid: 7784, signal: 'SIGTERM' }]);
      if (targetStatus === 'gone') {
        expect(outcome).toBe(discoveryError);
      } else if (targetStatus === 'alive') {
        expectHandoffRefusal(
          outcome,
          'handoff_accepted_signal_target_alive_after_failure',
          { stage: 'after-accepted-signal-failure', pid: 7784, signal: 'SIGTERM' },
          discoveryError,
        );
      } else {
        expectHandoffRefusal(
          outcome,
          'handoff_process_liveness_unknown',
          { stage: 'after-accepted-signal-failure', pid: 7784, signal: 'SIGTERM' },
          discoveryError,
        );
      }
    },
  );

  it('logs the accepted signal settlement and propagates a startup abort unchanged', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('operator stopped startup', 'AbortError');
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7788,
      incarnation: testIncarnation(556_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signal: controller.signal,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'abort-incumbent',
        token: 'token-abort',
        bootToken: 'boot-token-abort',
        shutdownToken: 'shutdown-token-abort',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    try {
      const promise = bindWithHandoff(options).catch((error: unknown) => error);
      for (let i = 0; i < 30 && !killCalls.some((call) => call.signal === 'SIGTERM'); i += 1) {
        await flush();
        time.tick(200);
      }
      controller.abort(abortReason);
      for (let i = 0; i < 10; i += 1) {
        await flush();
        time.tick(200);
      }

      await expect(promise).resolves.toBe(abortReason);
      expect(killCalls).toEqual([{ pid: 7788, signal: 'SIGTERM' }]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Startup aborted after the kernel accepted SIGTERM for incumbent pid=7788; observed target status=alive',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('benign discovery identity change before signaling resets and retries the new incumbent', async () => {
    const oldIdentity: IncumbentIdentity = {
      pid: 7001,
      incarnation: testIncarnation(101_000),
      source: 'discovery',
      instanceId: 'old-incumbent',
      token: 'old-token',
      bootToken: 'old-boot-token',
      shutdownToken: 'old-shutdown-token',
    };
    const newIdentity: IncumbentIdentity = {
      pid: 7002,
      incarnation: testIncarnation(202_000),
      source: 'discovery',
      instanceId: 'new-incumbent',
      token: 'new-token',
      bootToken: 'new-boot-token',
      shutdownToken: 'new-shutdown-token',
    };
    const discoveryReads: IncumbentIdentity[] = [oldIdentity, newIdentity, newIdentity, newIdentity];
    const { options, time, killCalls } = buildHarness({
      bindSequence: [
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'bound' },
      ],
      totalBudgetMs: 5_000,
      readDiscovery: () => discoveryReads.shift() ?? newIdentity,
    });
    mockedShutdown
      .mockResolvedValueOnce(shutdownResult({ health: null, verifiedIdentity: oldIdentity }))
      .mockResolvedValueOnce(shutdownResult({ health: null, verifiedIdentity: newIdentity }));

    const promise = bindWithHandoff(options);
    for (let i = 0; i < 20; i += 1) {
      await flush();
      time.tick(200);
    }

    await expect(promise).resolves.toEqual({
      acquiredViaHandoff: true,
      runStartupRecovery: expect.any(Function),
    });
    expect(mockedShutdown).toHaveBeenCalledTimes(2);
    expect(mockedShutdown.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ bootToken: 'old-boot-token' }));
    expect(mockedShutdown.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ bootToken: 'new-boot-token' }));
    expect(killCalls).toEqual([]);
  });

  it('audits handoff signals without logging coordinator tokens', async () => {
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    try {
      const verifiedIdentity: IncumbentIdentity = {
        pid: 7654,
        incarnation: testIncarnation(444_000),
        source: 'health',
      };
      const { options, time } = buildHarness({
        bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
        totalBudgetMs: 500,
        killReturns: () => false,
        readDiscovery: () => ({
          ...verifiedIdentity,
          source: 'discovery',
          instanceId: 'audit-incumbent',
          token: 'secret-admin-token',
          bootToken: 'secret-boot-token',
          shutdownToken: 'secret-shutdown-token',
        }),
      });
      mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
      mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

      const promise = bindWithHandoff(options).catch((e: Error) => e);
      for (let i = 0; i < 80; i += 1) {
        await flush();
        time.tick(200);
      }
      await promise;

      const messages = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((call) => String(call[0] ?? ''));
      const auditMessages = messages.filter(
        (message) => message.startsWith('audit ') && message.includes('"event":"handoff_signal"'),
      );
      expect(auditMessages.length).toBeGreaterThan(0);
      expect(auditMessages.some((message) => message.includes('"instanceId":"audit-incumbent"'))).toBe(true);
      expect(auditMessages.every((message) => message.includes('"attemptedAtMs":'))).toBe(true);
      expect(auditMessages.every((message) => !message.includes('"signaledAtMs":'))).toBe(true);
      expect(auditMessages.some((message) => message.includes('"result":"rejected"'))).toBe(true);
      expect(auditMessages.join('\n')).not.toContain('secret-admin-token');
      expect(auditMessages.join('\n')).not.toContain('secret-boot-token');
      expect(auditMessages.join('\n')).not.toContain('secret-shutdown-token');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('process gone before signal → retries bind without signaling', async () => {
    let alive = true;
    const verifiedIdentity: IncumbentIdentity = {
      pid: 99999,
      incarnation: testIncarnation(999_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
      observeLiveness: () => (alive ? 'alive' : 'absent'),
      totalBudgetMs: 500,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockImplementation(() => {
      // Simulate process gone right at SIGTERM revalidation: probe returns null.
      return null;
    });
    // For verifySignalTarget to return 'gone', observeLiveness must also return false.
    alive = false;

    const promise = bindWithHandoff(options);
    for (let i = 0; i < 50; i += 1) {
      await flush();
      time.tick(200);
    }
    await flush();
    const result = await promise;
    expect(result.acquiredViaHandoff).toBe(true);
    expect(killCalls.filter((c) => c.signal === 'SIGTERM').length).toBe(0);
  });

  it('does not authorize SIGTERM from a matching incarnation when liveness is unknown', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 10004,
      incarnation: testIncarnation(1_004_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: () => 'unknown',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'unknown-before-signal',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((error: Error) => error);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expectHandoffRefusal(outcome, 'handoff_process_liveness_unknown', { stage: 'before-signal', pid: 10004 });
    expect(killCalls).toEqual([]);
  });

  // The two halves of the same incident, and they must not be conflated again.
  //
  // A disagreement between what the incumbent published and what this contender probes must not cost the
  // *credential*: rejecting the record on that basis discarded the boot token beside it, and a contender
  // without that token cannot ask anyone to stand down — which is how a newer build died on every session
  // start. So the shutdown RPC still runs, with the token.
  //
  // It must cost the *signal*. Under the old derivation a disagreement was unavoidable noise (168 seconds
  // measured on WSL2 between two processes reading the same clock). With the opaque token two probes of one
  // process agree, so a disagreement now means what it says: this pid is not the process the record is
  // about — a stale `coordinator.json` and an ordinary pid wrap are enough — and signalling it delivers
  // SIGKILL to a stranger.
  it('uses the token but refuses to signal a pid the incumbent did not publish', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 4321, incarnation: testIncarnation(500), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-drift',
        token: 'token-drift',
        bootToken: 'boot-token-drift',
        shutdownToken: 'shutdown-token-drift',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    // Consistent within this process, and 168 away from what the incumbent reported.
    mockedProbe.mockReturnValue(testIncarnation(668));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 5; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    // The credential must survive the disagreement and be used: this is the whole reason the record is
    // no longer rejected. Before the change no token reached this call, so `shutdownAttempted` stayed
    // false and the contender died on the gate that exists to catch a missing credential.
    expect(mockedShutdown).toHaveBeenCalledWith(expect.objectContaining({ bootToken: 'boot-token-drift' }));

    expectHandoffRefusal(outcome, 'handoff_published_incarnation_mismatch', {
      stage: 'before-signal',
      pid: 4321,
    });
    expect(killCalls, 'a pid the incumbent did not publish must never be signalled').toEqual([]);
  });

  // The upgrade this branch exists for: the incumbent is a build that predates the token, so it publishes no
  // incarnation at all. Its boot token still works, so it steps down gracefully — that path is untouched, and
  // it is the path an ordinary upgrade takes. What it cannot do is authorize a kill: with nothing published,
  // the only baseline is this contender's own first look, and a pid recycled before that look matches itself
  // forever. An unresponsive predecessor therefore ends in a diagnostic the operator acts on.
  it('asks a pre-token incumbent to stand down but will not escalate to a signal', async () => {
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({
        pid: 7777,
        source: 'discovery',
        instanceId: 'pre-token-incumbent',
        token: 'token-legacy',
        bootToken: 'boot-token-legacy',
        shutdownToken: 'shutdown-token-legacy',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    mockedProbe.mockReturnValue(testIncarnation(4_242));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 40; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expect(mockedShutdown).toHaveBeenCalledWith(expect.objectContaining({ bootToken: 'boot-token-legacy' }));
    expectHandoffRefusal(outcome, 'handoff_published_incarnation_missing', {
      stage: 'before-signal',
      pid: 7777,
    });
    expect(killCalls, 'an incumbent that published no incarnation must never be signalled').toEqual([]);
  });

  // Everything an eviction needs is present here — a published incarnation, a matching probe, a live pid —
  // and it is still refused, because on macOS that agreement is not proof. `ps -o lstart=` is wall clock at
  // one-second resolution and macOS exposes no boot-relative start, so a backward clock step inside one boot
  // lets a later process reuse a pid and land on the same displayed second. Two processes, one token. The
  // graceful path is untouched: the shutdown RPC still ran with the token, which is how an ordinary upgrade
  // proceeds. What macOS gives up is forcing out a peer that will not answer.
  it('refuses to signal on a platform whose identity two processes can share', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 8181, incarnation: testIncarnation(700), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: () => 'alive' as const,
      platform: 'darwin',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'darwin-incumbent',
        token: 'token-darwin',
        bootToken: 'boot-token-darwin',
        shutdownToken: 'shutdown-token-darwin',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(testIncarnation(700));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 40; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expect(mockedShutdown).toHaveBeenCalledWith(expect.objectContaining({ bootToken: 'boot-token-darwin' }));
    expectHandoffRefusal(outcome, 'handoff_platform_identity_insufficient', {
      stage: 'before-signal',
      pid: 8181,
    });
    expect(killCalls, 'a matching incarnation is not proof on a platform that cannot make it one').toEqual([]);
  });

  // The guarantee that survives: between the handshake and the signal, the pid must still name the same
  // process. Both observations are this contender's own, so the comparison is meaningful.
  it('refuses to signal when the pid was recycled after this contender observed it', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 1234, incarnation: testIncarnation(500), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    // The first probe is consumed by the handshake anchor; every later one sees a different process on
    // the same pid. Discovery populates `incumbent` before the handshake, which is the ordinary path —
    // an earlier revision anchored only when discovery had NOT, so this exact path reached escalation
    // with no baseline and both of its adjacent probes agreed on the recycled process.
    mockedProbe.mockReturnValueOnce(testIncarnation(999)).mockReturnValue(testIncarnation(1_001));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_pid_recycled', { stage: 'before-signal', pid: 1234 });
    expect(killCalls, 'a recycled pid must never be signalled').toEqual([]);
  });

  // The path that had no baseline at all: discovery names the incumbent, the handshake authenticates
  // nothing (a bound but IPC-silent daemon), and the pid is recycled before escalation. If the baseline
  // is taken at escalation instead of at adoption, both probes see the replacement, they agree, and the
  // unrelated process is signalled. Adoption-time anchoring is what makes the two probes span the window.
  it('refuses to signal a recycled pid even when the handshake authenticated nothing', async () => {
    const verifiedFromDiscovery: IncumbentIdentity = {
      pid: 9091,
      incarnation: testIncarnation(1_111_000),
      source: 'discovery',
      instanceId: 'silent-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => verifiedFromDiscovery,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    // Adoption observes the incumbent; everything after observes the process that took its pid.
    mockedProbe.mockReturnValueOnce(testIncarnation(1_111_000)).mockReturnValue(testIncarnation(2_222_000));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 80; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_pid_recycled', { stage: 'before-signal', pid: 9091 });
    expect(killCalls, 'a pid recycled before escalation must never be signalled').toEqual([]);
  }, 10_000);

  // An unreadable incarnation is not a dead process. Treating it as one skipped the fail-closed branch
  // and let a later, too-late probe become the baseline.
  it('refuses to signal when the incarnation is unreadable while the pid is alive', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 2468, incarnation: testIncarnation(500), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValueOnce(testIncarnation(777)).mockReturnValue(null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_process_identity_unavailable', { stage: 'before-signal', pid: 2468 });
    expect(killCalls, 'unreadable must not be read as gone').toEqual([]);
  });

  it('identity change at immediate pre-signal revalidation stays fatal', async () => {
    const oldIdentity: IncumbentIdentity = {
      pid: 4320,
      incarnation: testIncarnation(699),
      source: 'discovery',
      instanceId: 'old-pre-signal',
      token: 'old-token',
      bootToken: 'old-boot-token',
      shutdownToken: 'old-shutdown-token',
    };
    const newIdentity: IncumbentIdentity = {
      pid: 4322,
      incarnation: testIncarnation(701),
      source: 'discovery',
      instanceId: 'new-pre-signal',
      token: 'new-token',
      bootToken: 'new-boot-token',
      shutdownToken: 'new-shutdown-token',
    };
    let reads = 0;
    const { options, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 0,
      readDiscovery: () => {
        reads += 1;
        return reads === 1 ? oldIdentity : newIdentity;
      },
    });

    const outcome = await bindWithHandoff(options).catch((e: Error) => e);

    expectHandoffRefusal(outcome, 'handoff_fresh_discovery_changed', { stage: 'before-signal', pid: 4320 });
    expect(mockedShutdown).not.toHaveBeenCalled();
    expect(killCalls).toEqual([]);
  });

  it('refuses to signal when fresh discovery identity is unavailable', async () => {
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => null,
    });
    const verifiedIdentity: IncumbentIdentity = {
      pid: 4321,
      incarnation: testIncarnation(700),
      source: 'health',
    };
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(testIncarnation(700));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_fresh_discovery_unavailable', { stage: 'before-signal', pid: 4321 });
    expect(killCalls).toEqual([]);
  });

  it.each([
    {
      case: 'genuine v0.10.9 bytes',
      nowMs: 2_000,
      shadow: {
        version: 1,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGTERM',
        signaledAtMs: 1_000,
      },
      expected: { kind: 'foreign-signal-attempt', signal: 'SIGTERM', ageMs: 1_000, retryInMs: 59_000 },
    },
    {
      case: 'this build paired shadow and detail',
      nowMs: 2_000,
      detail: {
        version: 2,
        accepted: true,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGKILL',
        signaledAtMs: 1_000,
        publicationId: 'paired-publication',
      },
      shadow: {
        version: 1,
        accepted: true,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGKILL',
        signaledAtMs: 1_000,
        publicationId: 'paired-publication',
      },
      expected: { kind: 'accepted-signal', signal: 'SIGKILL', ageMs: 1_000, retryInMs: 59_000 },
    },
    {
      case: 'two independent publications',
      nowMs: 3_000,
      detail: {
        version: 2,
        accepted: true,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGTERM',
        signaledAtMs: 1_000,
        publicationId: 'detail-publication',
      },
      shadow: {
        version: 1,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGKILL',
        signaledAtMs: 2_000,
      },
      expected: { kind: 'foreign-signal-attempt', signal: 'SIGKILL', ageMs: 1_000, retryInMs: 59_000 },
    },
    {
      case: 'a wall clock that stepped backward',
      nowMs: 1_000,
      detail: {
        version: 2,
        accepted: true,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGTERM',
        signaledAtMs: 10_000,
        publicationId: 'before-clock-step',
      },
      shadow: {
        version: 1,
        accepted: true,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGKILL',
        signaledAtMs: 1_000,
        publicationId: 'after-clock-step',
      },
      expected: { kind: 'accepted-signal', signal: 'SIGTERM', ageMs: -9_000, retryInMs: 69_000 },
    },
    {
      case: 'an independent conservative record tied on recency',
      nowMs: 2_000,
      detail: {
        version: 2,
        accepted: true,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGTERM',
        signaledAtMs: 1_000,
        publicationId: 'independent-detail',
      },
      shadow: {
        version: 1,
        socketPath: '/tmp/coral.sock',
        pid: 2467,
        incarnation: testIncarnation(899),
        instanceId: 'same-incumbent',
        signal: 'SIGKILL',
        signaledAtMs: 1_000,
      },
      expected: { kind: 'foreign-signal-attempt', signal: 'SIGKILL', ageMs: 1_000, retryInMs: 59_000 },
    },
  ])('classifies ledger cooldown disposition from durable $case', ({ detail, shadow, nowMs, expected }) => {
    expect(durableLedgerDisposition({ detail, shadow, nowMs })).toEqual(expected);
  });

  it('writes a shipped-v0.10.9-valid cooldown shadow before accepted V2 detail', async () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const verifiedIdentity: IncumbentIdentity = {
      pid: 2466,
      incarnation: testIncarnation(898),
      source: 'health',
    };
    const storage = {
      readFileSync: (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error('ENOENT');
        return value;
      },
      mkdirSync: vi.fn(),
      writeAtomicSync: (path: string, value: string) => {
        writes.push(path);
        files.set(path, value);
      },
    } as unknown as Parameters<typeof createFileHandoffSignalLedger>[0]['storage'];
    const signalLedger = createFileHandoffSignalLedger({ storage, ids: countingIds(), runDir: '/tmp/run' });
    let signalAccepted = false;
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
      totalBudgetMs: 0,
      observeLiveness: () => (signalAccepted ? 'absent' : 'alive'),
      killReturns: () => {
        signalAccepted = true;
        return true;
      },
      signalLedger,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'accepted-incumbent',
        token: 'accepted-token',
        bootToken: 'accepted-boot-token',
        shutdownToken: 'accepted-shutdown-token',
      }),
    });
    mockedProbe.mockImplementation(() => (signalAccepted ? null : (verifiedIdentity.incarnation ?? null)));

    const promise = bindWithHandoff(options);
    await flush();
    time.tick(200);
    await flush();
    await expect(promise).resolves.toMatchObject({ acquiredViaHandoff: true });

    const shippedShadow = JSON.parse(files.get('/tmp/run/handoff-signal.json') ?? 'null') as unknown;
    const shadowSignaledAtMs = (shippedShadow as { signaledAtMs: number }).signaledAtMs;
    expect(shippedV0109IsHandoffSignalRecord(shippedShadow)).toBe(true);
    expect(
      shippedV0109CooldownApplies(
        shippedShadow,
        '/tmp/coral.sock',
        {
          pid: 2466,
          incarnation: testIncarnation(898),
          source: 'discovery',
          instanceId: 'accepted-incumbent',
        },
        shadowSignaledAtMs + 500,
        10_000,
      ),
    ).toBe(true);
    expect(shippedShadow).toHaveProperty('accepted', true);
    expect(files.has('/tmp/run/handoff-signal.v2.json')).toBe(true);
    expect(writes).toEqual(['/tmp/run/handoff-signal.json', '/tmp/run/handoff-signal.v2.json']);
    expect(killCalls).toEqual([{ pid: verifiedIdentity.pid, signal: 'SIGTERM' }]);
  });

  it('uses a newer accepted V1 shadow instead of stale matching V2 detail for cooldown', async () => {
    const target: IncumbentIdentity = {
      pid: 2467,
      incarnation: testIncarnation(899),
      source: 'discovery',
      instanceId: 'same-incumbent',
    };
    let nowMs = 0;
    const storage = {
      readFileSync: (path: string) => {
        if (path === '/tmp/run/handoff-signal.v2.json') {
          return JSON.stringify({
            version: 2,
            accepted: true,
            socketPath: '/tmp/coral.sock',
            pid: target.pid,
            incarnation: target.incarnation,
            instanceId: target.instanceId,
            signal: 'SIGTERM',
            signaledAtMs: nowMs - 70_000,
          });
        }
        if (path === '/tmp/run/handoff-signal.json') {
          return JSON.stringify({
            version: 1,
            accepted: true,
            socketPath: '/tmp/coral.sock',
            pid: target.pid,
            incarnation: target.incarnation,
            instanceId: target.instanceId,
            signal: 'SIGTERM',
            signaledAtMs: nowMs - 1_000,
          });
        }
        throw new Error('ENOENT');
      },
      mkdirSync: vi.fn(),
      writeAtomicSync: vi.fn(),
    } as unknown as Parameters<typeof createFileHandoffSignalLedger>[0]['storage'];
    const signalLedger = createFileHandoffSignalLedger({ storage, ids: countingIds(), runDir: '/tmp/run' });
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 0,
      signalLedger,
      signalCooldownMs: 60_000,
      killReturns: () => false,
      readDiscovery: () => ({
        ...target,
        token: 'same-token',
        bootToken: 'same-boot-token',
        shutdownToken: 'same-shutdown-token',
      }),
    });
    nowMs = time.now();
    mockedProbe.mockReturnValue(target.incarnation ?? null);

    const outcome = await bindWithHandoff(options).catch((error: Error) => error);

    expectHandoffRefusal(outcome, 'handoff_signal_cooldown_active', {
      stage: 'before-signal',
      pid: 2467,
      requestedSignal: 'SIGTERM',
      previousSignal: 'SIGTERM',
      ageMs: 1_000,
      retryInMs: 59_000,
    });
    expect(killCalls).toEqual([]);
  });

  it('uses the newer shadow when the wall clock steps backward before a detail write fails', () => {
    const files = new Map<string, string>();
    let rejectDetail = false;
    const storage = {
      readFileSync: (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error('ENOENT');
        return value;
      },
      mkdirSync: vi.fn(),
      writeAtomicSync: (path: string, value: string) => {
        if (rejectDetail && path === '/tmp/run/handoff-signal.v2.json') throw new Error('detail write failed');
        files.set(path, value);
      },
    } as unknown as Parameters<typeof createFileHandoffSignalLedger>[0]['storage'];
    const signalLedger = createFileHandoffSignalLedger({ storage, ids: countingIds(), runDir: '/tmp/run' });
    const target: IncumbentIdentity = {
      pid: 2468,
      incarnation: testIncarnation(900),
      source: 'discovery',
      instanceId: 'backward-clock-incumbent',
    };
    const record = {
      version: 2 as const,
      accepted: true as const,
      socketPath: '/tmp/coral.sock',
      pid: target.pid,
      incarnation: target.incarnation,
      instanceId: target.instanceId,
      signal: 'SIGTERM' as const,
      signaledAtMs: 10_000,
    };
    signalLedger.write(record);
    rejectDetail = true;
    signalLedger.write({ ...record, signal: 'SIGKILL', signaledAtMs: 1_000 });

    expect(
      signalLedger.cooldownDisposition({
        socketPath: '/tmp/coral.sock',
        incumbent: target,
        nowMs: 1_000,
        cooldownMs: 60_000,
      }),
    ).toEqual({
      kind: 'accepted-signal',
      signal: 'SIGTERM',
      ageMs: -9_000,
      retryInMs: 69_000,
    });
  });

  it('does not publish V2 detail when the shipped cooldown shadow write fails', async () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const verifiedIdentity: IncumbentIdentity = {
      pid: 2469,
      incarnation: testIncarnation(901),
      source: 'health',
    };
    const storage = {
      readFileSync: (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error('ENOENT');
        return value;
      },
      mkdirSync: vi.fn(),
      writeAtomicSync: (path: string, value: string) => {
        writes.push(path);
        if (path === '/tmp/run/handoff-signal.json') throw new Error('shadow write failed');
        files.set(path, value);
      },
    } as unknown as Parameters<typeof createFileHandoffSignalLedger>[0]['storage'];
    const signalLedger = createFileHandoffSignalLedger({ storage, ids: countingIds(), runDir: '/tmp/run' });
    let signalAccepted = false;
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
      totalBudgetMs: 0,
      observeLiveness: () => (signalAccepted ? 'absent' : 'alive'),
      killReturns: () => {
        signalAccepted = true;
        return true;
      },
      signalLedger,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'shadow-failure-incumbent',
        token: 'shadow-failure-token',
        bootToken: 'shadow-failure-boot-token',
        shutdownToken: 'shadow-failure-shutdown-token',
      }),
    });
    mockedProbe.mockImplementation(() => (signalAccepted ? null : (verifiedIdentity.incarnation ?? null)));

    const promise = bindWithHandoff(options);
    await flush();
    time.tick(200);
    await flush();
    await expect(promise).resolves.toMatchObject({ acquiredViaHandoff: true });

    expect(writes).toEqual(['/tmp/run/handoff-signal.json']);
    expect(files.has('/tmp/run/handoff-signal.v2.json')).toBe(false);
    expect(killCalls).toEqual([{ pid: verifiedIdentity.pid, signal: 'SIGTERM' }]);
  });

  it('decodes a genuine shipped V1 ledger entry as an indeterminate legacy attempt', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 2467,
      incarnation: testIncarnation(899),
      source: 'health',
    };
    let legacyAttemptedAtMs = 0;
    const storage = {
      readFileSync: (path: string) => {
        if (path !== '/tmp/run/handoff-signal.json') throw new Error('ENOENT');
        return JSON.stringify({
          version: 1,
          socketPath: '/tmp/coral.sock',
          pid: verifiedIdentity.pid,
          incarnation: verifiedIdentity.incarnation,
          instanceId: 'legacy-incumbent',
          signal: 'SIGTERM',
          signaledAtMs: legacyAttemptedAtMs,
        });
      },
      mkdirSync: vi.fn(),
      writeAtomicSync: vi.fn(),
    } as unknown as Parameters<typeof createFileHandoffSignalLedger>[0]['storage'];
    const signalLedger = createFileHandoffSignalLedger({ storage, ids: countingIds(), runDir: '/tmp/run' });
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signalLedger,
      signalCooldownMs: 10_000,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'legacy-incumbent',
        token: 'same-token',
        bootToken: 'same-boot-token',
        shutdownToken: 'same-shutdown-token',
      }),
    });
    legacyAttemptedAtMs = time.now();
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((error: Error) => error);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expectHandoffRefusal(outcome, 'handoff_legacy_signal_attempt_indeterminate', {
      stage: 'before-signal',
      pid: 2467,
      requestedSignal: 'SIGTERM',
      previousSignal: 'SIGTERM',
      ageMs: 600,
      retryInMs: 9_400,
    });
    expect(killCalls).toEqual([]);
  });

  it('rate-limits a repeated SIGTERM from an accepted V2 record for the same incumbent', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 2468,
      incarnation: testIncarnation(900),
      source: 'health',
    };
    let lastSignaledAtMs = 0;
    const signalLedger: HandoffSignalLedger = {
      cooldownDisposition: ({ nowMs, cooldownMs }) => ({
        kind: 'accepted-signal',
        signal: 'SIGTERM',
        ageMs: nowMs - lastSignaledAtMs,
        retryInMs: cooldownMs - (nowMs - lastSignaledAtMs),
      }),
      write: vi.fn(),
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signalLedger,
      signalCooldownMs: 10_000,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'same-incumbent',
        token: 'same-token',
        bootToken: 'same-boot-token',
        shutdownToken: 'same-shutdown-token',
      }),
    });
    lastSignaledAtMs = time.now();
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_signal_cooldown_active', {
      stage: 'before-signal',
      pid: 2468,
      requestedSignal: 'SIGTERM',
      previousSignal: 'SIGTERM',
      ageMs: 600,
      retryInMs: 9_400,
    });
    expect(killCalls).toEqual([]);
  });

  it('manual signal policy refuses process signals after graceful handoff fails', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 1357,
      incarnation: testIncarnation(901),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signalPolicy: 'manual',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_manual_policy', {
      stage: 'before-signal',
      pid: 1357,
      policy: 'manual',
    });
    expect(killCalls).toEqual([]);
  });

  it('manual signal policy remains decisive when deadline discovery is unavailable', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 1357,
      incarnation: testIncarnation(901),
      source: 'health',
    };
    let discoveryReads = 0;
    const { options, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 0,
      signalPolicy: 'manual',
      readDiscovery: () => {
        discoveryReads += 1;
        return discoveryReads === 1
          ? {
              ...verifiedIdentity,
              source: 'discovery',
              bootToken: 'boot-token',
              shutdownToken: 'shutdown-token',
            }
          : null;
      },
    });

    const outcome = await bindWithHandoff(options).catch((e: Error) => e);

    expectHandoffRefusal(outcome, 'handoff_manual_policy', {
      stage: 'before-signal',
      pid: 1357,
      policy: 'manual',
    });
    expect(discoveryReads).toBe(1);
    expect(killCalls).toEqual([]);
  });

  it('refuses to signal when fresh discovery lacks signal capability fields', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 9753,
      incarnation: testIncarnation(903),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_signal_capability_unavailable', {
      stage: 'before-signal',
      pid: 9753,
      missingFields: ['instanceId', 'token', 'bootToken'],
    });
    expect(killCalls).toEqual([]);
  });

  it('term-only signal policy sends SIGTERM but refuses SIGKILL', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 8642,
      incarnation: testIncarnation(902),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signalPolicy: 'term-only',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'term-only-incumbent',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < (SIGTERM_GRACE_MS + 2_000) / 200; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_term_only_policy', {
      stage: 'after-sigterm-grace',
      pid: 8642,
      graceMs: SIGTERM_GRACE_MS,
      policy: 'term-only',
    });
    expect(killCalls.filter((c) => c.signal === 'SIGTERM')).toHaveLength(1);
    expect(killCalls.filter((c) => c.signal === 'SIGKILL')).toHaveLength(0);
  });

  it('does not authorize SIGKILL when matched identity has unknown liveness after SIGTERM grace', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 8644,
      incarnation: testIncarnation(905),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: (_pid, _killAttempted, calls) =>
        calls.some((call) => call.signal === 'SIGTERM') ? 'unknown' : 'alive',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'unknown-after-sigterm',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation ?? null);

    const promise = bindWithHandoff(options).catch((error: Error) => error);
    for (let i = 0; i < (SIGTERM_GRACE_MS + 4_000) / 200; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expectHandoffRefusal(outcome, 'handoff_process_liveness_unknown', {
      stage: 'after-sigterm-grace',
      pid: 8644,
      signal: 'SIGTERM',
      graceMs: SIGTERM_GRACE_MS,
    });
    expect(killCalls.filter((call) => call.signal === 'SIGTERM')).toHaveLength(1);
    expect(killCalls.filter((call) => call.signal === 'SIGKILL')).toHaveLength(0);
  });

  it('settles accepted SIGTERM as gone before policy or fresh discovery can refuse', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 8643,
      incarnation: testIncarnation(904),
      source: 'health',
    };
    let sigtermAccepted = false;
    let targetObservedGone = false;
    const signalLedger: HandoffSignalLedger = { cooldownDisposition: () => ({ kind: 'clear' }), write: vi.fn() };
    const { options, time, killCalls } = buildHarness({
      bindAttempt: async () =>
        targetObservedGone ? { kind: 'bound' } : { kind: 'incumbent', reason: 'live-listener' },
      totalBudgetMs: 500,
      signalPolicy: 'term-only',
      observeLiveness: () => {
        if (!sigtermAccepted) {
          return 'alive';
        }
        targetObservedGone = true;
        return 'absent';
      },
      killReturns: (signal) => {
        sigtermAccepted = signal === 'SIGTERM';
        return true;
      },
      signalLedger,
      readDiscovery: () =>
        sigtermAccepted
          ? null
          : {
              ...verifiedIdentity,
              source: 'discovery',
              instanceId: 'term-only-gone',
              token: 'token',
              bootToken: 'boot-token',
              shutdownToken: 'shutdown-token',
            },
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValueOnce(verifiedIdentity.incarnation ?? null)
      .mockReturnValue(null);

    const promise = bindWithHandoff(options);
    for (let i = 0; i < (SIGTERM_GRACE_MS + 4_000) / 200; i += 1) {
      await flush();
      time.tick(200);
    }

    await expect(promise).resolves.toMatchObject({ acquiredViaHandoff: true });
    expect(killCalls).toEqual([{ pid: 8643, signal: 'SIGTERM' }]);
    expect(signalLedger.write).toHaveBeenCalledTimes(1);
  });

  it('follows a successor after a signalled incumbent disappears and reports the successor after another grace pair', async () => {
    const first: IncumbentIdentity = {
      pid: 9_001,
      incarnation: testIncarnation(9_001),
      source: 'discovery',
      instanceId: 'first-incumbent',
      token: 'first-token',
      bootToken: 'first-boot-token',
      shutdownToken: 'first-shutdown-token',
    };
    const successor: IncumbentIdentity = {
      pid: 9_002,
      incarnation: testIncarnation(9_002),
      source: 'discovery',
      instanceId: 'successor-incumbent',
      token: 'successor-token',
      bootToken: 'successor-boot-token',
      shutdownToken: 'successor-shutdown-token',
    };
    let firstSignalAccepted = false;
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => (firstSignalAccepted ? successor : first),
      observeLiveness: (pid) => (pid === first.pid && firstSignalAccepted ? 'absent' : 'alive'),
      killReturns: (signal) => {
        if (signal === 'SIGTERM' && !firstSignalAccepted) firstSignalAccepted = true;
        return true;
      },
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    mockedProbe.mockImplementation((pid) =>
      pid === first.pid ? (first.incarnation ?? null) : (successor.incarnation ?? null),
    );

    const promise = bindWithHandoff(options).catch((error: unknown) => error);
    const elapsedMs = 500 + SIGTERM_GRACE_MS * 2 + SIGKILL_GRACE_MS + 5_000;
    for (let elapsed = 0; elapsed < elapsedMs; elapsed += 200) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expectHandoffRefusal(outcome, 'handoff_sigkill_grace_target_alive', {
      stage: 'after-sigkill-grace',
      pid: successor.pid,
      signal: 'SIGKILL',
      graceMs: SIGKILL_GRACE_MS,
    });
    expect(killCalls).toEqual([
      { pid: first.pid, signal: 'SIGTERM' },
      { pid: successor.pid, signal: 'SIGTERM' },
      { pid: successor.pid, signal: 'SIGKILL' },
    ]);
  });

  it('discovery fallback: when health has no pid, reads coordinator.json via injected probe', async () => {
    const verifiedFromDiscovery: IncumbentIdentity = {
      pid: 8888,
      incarnation: testIncarnation(1_111_000),
      source: 'discovery',
      instanceId: 'discovery-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => verifiedFromDiscovery,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    mockedProbe.mockReturnValue(testIncarnation(1_111_000)); // matched

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    // Need enough time to: exhaust budget (500), SIGTERM_GRACE (5000),
    // SIGKILL_GRACE (5000). 80 × 200 = 16000ms covers all phases.
    for (let i = 0; i < 80; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expectHandoffRefusal(outcome, 'handoff_sigkill_grace_target_alive', {
      stage: 'after-sigkill-grace',
      pid: 8888,
      signal: 'SIGKILL',
      graceMs: SIGKILL_GRACE_MS,
    });
    expect(killCalls.some((c) => c.signal === 'SIGTERM' && c.pid === 8888)).toBe(true);
  }, 10_000);

  it('no shutdown RPC issued after drain deadline', async () => {
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 200,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    const callsAtDeadline: number[] = [];

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
      callsAtDeadline.push(mockedShutdown.mock.calls.length);
    }
    await promise;

    expect(mockedShutdown.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
