import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHandoff, validateForeignHandoffTarget, type HandoffOperation } from '#src/coordinator/handoff-runner.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type { TimePort } from '#src/infra/port-types.js';
import { serializeWaitCursor } from '#src/jobs/wait.js';

type StrictBundleManifest = BundleManifestMod.StrictBundleManifest;

const mockState = vi.hoisted(() => ({
  createIpcClient: vi.fn(),
  createRealRuntime: vi.fn(),
  health: vi.fn(),
  probeCoordinator: vi.fn(),
  readBuildFlavor: vi.fn(),
  resolveStrictBundleIdentity: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, spawn: mockState.spawn };
});

vi.mock('#src/infra/backend-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendDiscoveryMod>();
  return { ...actual, probeCoordinator: mockState.probeCoordinator };
});

vi.mock('#src/infra/bundle-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BundleManifestMod>();
  return {
    ...actual,
    readBuildFlavor: mockState.readBuildFlavor,
    resolveStrictBundleIdentity: mockState.resolveStrictBundleIdentity,
  };
});

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: mockState.createRealRuntime,
}));

vi.mock('#src/transport/ipc/client.js', () => ({
  createIpcClient: mockState.createIpcClient,
}));

const GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';
const originalGuard = process.env[GUARD_ENV];
const roots: string[] = [];
const backendBundle = 'handoff runner backend fixture';
const cliBundle = 'handoff runner cli fixture';
const claudeAppserverBundle = 'handoff runner claude appserver fixture';
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '223e4567-e89b-42d3-a456-426614174000',
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};
const invokingManifest: StrictBundleManifest = {
  ...manifest,
  version: '1.0.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
};
const socketPath = join(tmpdir(), 'coral-handoff-runner.sock');
const runtime = {
  storage: {},
  time: {
    // The drain arms a real timer through the port, so the double must actually schedule.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: { unref?(): void } | null) => {
      clearTimeout(handle as unknown as NodeJS.Timeout);
    },
  },
  env: {
    cwd: () => '/handoff/cwd',
    fullSnapshot: () => ({ CORAL_BASE_ENV: 'preserved' }),
  },
  paths: { coral: { coordinator: { socketPath } } },
};

function createBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-handoff-runner-'));
  roots.push(root);
  writeFileSync(join(root, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(root, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(root, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return root;
}

function configureNewerIncumbent(bundleDir = createBundle()): string {
  mockState.probeCoordinator.mockReturnValue({
    kind: 'live',
    record: {
      socketPath,
      pid: 4242,
      bundleHash: manifest.bundleHash,
      flavor: manifest.flavor,
      namespace: 'handoff-runner',
      bootToken: 'boot-token',
    },
  });
  mockState.health.mockResolvedValue({
    status: 'ok',
    version: manifest.version,
    bundleHash: manifest.bundleHash,
    flavor: manifest.flavor,
    namespace: 'handoff-runner',
    instanceId: 'incumbent-1',
    pid: 4242,
    manifest,
    bundleDir,
  });
  return bundleDir;
}

function cliOperation(...args: string[]): HandoffOperation {
  return { kind: 'cli-invocation', argv: ['node', 'coral-cli', ...args] };
}

function childThatExits(code: number | null, signal: NodeJS.Signals | null): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => {
    child.emit('spawn');
    queueMicrotask(() => child.emit('exit', code, signal));
  });
  return child;
}

function childThatStaysAlive(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function validatedTarget(bundleDir: string) {
  const validation = validateForeignHandoffTarget(bundleDir, manifest);
  if (validation.kind !== 'validated') {
    throw new Error(`Expected a validated target, received ${validation.kind}`);
  }
  return validation.target;
}

beforeEach(() => {
  delete process.env[GUARD_ENV];
  mockState.createIpcClient.mockReset().mockReturnValue({ health: mockState.health });
  mockState.createRealRuntime.mockReset().mockReturnValue(runtime);
  mockState.health.mockReset();
  mockState.probeCoordinator.mockReset();
  mockState.readBuildFlavor.mockReset().mockReturnValue('prod');
  mockState.resolveStrictBundleIdentity.mockReset().mockReturnValue({ ok: true, manifest: invokingManifest });
  mockState.spawn.mockReset();
  configureNewerIncumbent();
  vi.spyOn(process.stdout, 'write').mockImplementation(((
    _chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  if (originalGuard === undefined) {
    delete process.env[GUARD_ENV];
  } else {
    process.env[GUARD_ENV] = originalGuard;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff-runner', () => {
  it.each([
    ['absent', undefined],
    ['zero', '0'],
  ])('should delegate when the guard is %s and propagate one', async (_label, guard) => {
    if (guard !== undefined) {
      process.env[GUARD_ENV] = guard;
    }
    const bundleDir = roots[0];
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    const result = await runHandoff(cliOperation('backend', 'status'), { pluginRoot: '/plugin/root' });

    expect(result).toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-success', version: manifest.version },
    });
    expect(mockState.spawn).toHaveBeenCalledWith(
      process.execPath,
      [join(bundleDir, 'coral-cli.cjs'), 'backend', 'status'],
      {
        cwd: '/handoff/cwd',
        env: { CORAL_BASE_ENV: 'preserved', [GUARD_ENV]: '1' },
        stdio: 'inherit',
      },
    );
  });

  it('should derive wait jobs argv from the job and seq cursor', async () => {
    const bundleDir = roots[0];
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await runHandoff(
      { kind: 'wait-jobs', jobId: 'job-1', serializedCursor: 'eyJhZnRlclNlcSI6N30' },
      { pluginRoot: '/plugin/root' },
    );

    expect(mockState.spawn).toHaveBeenCalledWith(
      process.execPath,
      [join(bundleDir, 'coral-cli.cjs'), 'wait', 'jobs', 'job-1', '--cursor', serializeWaitCursor({ afterSeq: 7 })],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('should return run-current without spawning when no incumbent is discoverable', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
    });

    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['-h'], ['--version']])(
    'should skip the incumbent probe for display-only invocation %s',
    async (flag) => {
      await expect(runHandoff(cliOperation(flag), { pluginRoot: '/plugin/root' })).resolves.toEqual({
        kind: 'run-current',
      });

      expect(mockState.createRealRuntime).not.toHaveBeenCalled();
      expect(mockState.probeCoordinator).not.toHaveBeenCalled();
    },
  );

  it.each(['', '2', '01', ' 1 ', 'true'])('should reject invalid delegation guard value %j as usage', async (guard) => {
    process.env[GUARD_ENV] = guard;

    // Owned by the runner, not `cli/errors.ts` — importing that would close a cli -> coordinator -> cli
    // cycle. `buildErrorEnvelope` maps it to invalid_usage / exit 2 on the CLI side.
    await expect(runHandoff(cliOperation('run'))).rejects.toMatchObject({ name: 'HandoffGuardError' });
    await expect(runHandoff(cliOperation('run'))).rejects.toThrow(GUARD_ENV);
    expect(mockState.probeCoordinator).not.toHaveBeenCalled();
  });

  it('should refuse a second delegation inside the routing authority', async () => {
    process.env[GUARD_ENV] = '1';

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).rejects.toThrow(
      /already delegated once/u,
    );
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should bypass the CLI guard for monotone backend startup delegation and confirm liveness without exit', async () => {
    process.env[GUARD_ENV] = 'not-a-cli-guard';
    const bundleDir = roots[0];
    const target = validatedTarget(bundleDir);
    let child: ChildProcess | undefined;
    const confirmationTimer = {};
    const confirmationDelays: number[] = [];
    let confirmAlive: (() => void) | undefined;
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: async () => {},
      setTimeout: vi.fn((fn: () => void, ms: number) => {
        confirmationDelays.push(ms);
        confirmAlive = fn;
        return confirmationTimer;
      }),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => confirmationTimer),
      clearInterval: vi.fn(),
    };
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatStaysAlive();
      return child;
    });

    // Startup delegates the same active-store selection again. Version precedence is strictly monotone, so
    // the selected build cannot classify the older caller as a target and bounce back.
    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, time },
    );
    await vi.waitFor(() => expect(child?.unref).toHaveBeenCalledOnce());

    expect(mockState.probeCoordinator).not.toHaveBeenCalled();
    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.spawn).toHaveBeenCalledWith(process.execPath, [join(bundleDir, 'coral-backend.cjs')], {
      cwd: '/handoff/cwd',
      env: { CORAL_BASE_ENV: 'preserved', [GUARD_ENV]: '1' },
      stdio: 'inherit',
      detached: true,
    });
    expect(time.setTimeout).toHaveBeenCalledOnce();
    expect(confirmationDelays).toHaveLength(1);
    expect(Number.isFinite(confirmationDelays[0])).toBe(true);
    expect(confirmationDelays[0]).toBeGreaterThan(0);

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    confirmAlive?.();
    await expect(result).resolves.toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-success', version: manifest.version },
    });
    expect(time.clearTimeout).toHaveBeenCalledWith(confirmationTimer);
  });

  it('should reject backend startup without a validated active-selection target instead of probing live health', async () => {
    process.env[GUARD_ENV] = 'not-a-cli-guard';

    await expect(runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root' })).rejects.toThrow(
      'Backend startup handoff requires a validated active-store target.',
    );

    expect(mockState.probeCoordinator).not.toHaveBeenCalled();
    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should accept an immediate backend startup exit when a live coordinator answers', async () => {
    const target = validatedTarget(roots[0]);
    let child: ChildProcess | undefined;
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatExits(0, null);
      return child;
    });

    await expect(
      runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
    ).resolves.toMatchObject({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-success', version: manifest.version },
    });
    expect(mockState.probeCoordinator).toHaveBeenCalledOnce();
    expect(mockState.health).toHaveBeenCalledOnce();
    expect(child?.unref).toHaveBeenCalledOnce();
  });

  it.each([0, 23])(
    'should report an immediate backend startup exit with code %s when no coordinator is live',
    async (code) => {
      const target = validatedTarget(roots[0]);
      let child: ChildProcess | undefined;
      mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
      mockState.spawn.mockImplementationOnce(() => {
        child = childThatExits(code, null);
        return child;
      });

      await expect(
        runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
      ).resolves.toEqual({
        kind: 'delegated',
        version: manifest.version,
        outcome: { kind: 'handoff-exit', exitCode: code },
      });
      expect(child?.unref).toHaveBeenCalledOnce();
    },
  );

  it('should reject a byte mismatch at the final re-hash without spawning', async () => {
    const bundleDir = roots[0];
    vi.mocked(process.stdout.write).mockImplementationOnce(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writeFileSync(join(bundleDir, 'coral-cli.cjs'), 'changed after validation', 'utf8');
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).rejects.toThrow(
      'bytes changed before execution',
    );
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should degrade an undrainable stdout to run-current without throwing', async () => {
    vi.useFakeTimers();
    let markDrainStarted: (() => void) | undefined;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    vi.mocked(process.stdout.write).mockImplementationOnce((() => {
      markDrainStarted?.();
      return false;
    }) as typeof process.stdout.write);

    const result = runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' });
    await drainStarted;
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toEqual({ kind: 'run-current' });
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should isolate a failed stdout drain from a later handoff attempt', async () => {
    vi.mocked(process.stdout.write)
      .mockImplementationOnce(((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(new Error('EPIPE'));
        return true;
      }) as typeof process.stdout.write)
      .mockImplementationOnce(((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.();
        return true;
      }) as typeof process.stdout.write);
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
    });
    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-success' },
    });
    expect(mockState.spawn).toHaveBeenCalledOnce();
  });

  it('should reject an invalid continuation operation before probing', async () => {
    const invalid = { kind: 'wait-jobs', jobId: '', serializedCursor: '' } as HandoffOperation;

    await expect(runHandoff(invalid)).rejects.toThrow();
    expect(mockState.probeCoordinator).not.toHaveBeenCalled();
  });

  it('should report child exit and signal outcomes through the delegated result', async () => {
    mockState.spawn
      .mockImplementationOnce(() => childThatExits(23, null))
      .mockImplementationOnce(() => childThatExits(null, 'SIGTERM'));

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-exit', exitCode: 23 },
    });
    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-signal', signal: 'SIGTERM' },
    });
  });

  it('should reject a child spawn failure', async () => {
    mockState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    });

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).rejects.toThrow('spawn failed');
  });

  it('should reject a backend startup spawn failure before the child reports spawn', async () => {
    const target = validatedTarget(roots[0]);
    mockState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', new Error('backend spawn failed')));
      return child;
    });

    await expect(
      runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
    ).rejects.toThrow('backend spawn failed');
  });
});
