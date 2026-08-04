import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import type { BackendRoutingResult } from '#src/infra/backend-routing.js';
import {
  createForeignTargetValidator,
  withValidatedHandoffTarget,
  type ValidatedHandoffTarget,
} from '#src/infra/handoff-target.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { resolveCliHandoffRouting, runHandoff, type HandoffOperation } from '#src/coordinator/handoff-runner.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, spawn: mockState.spawn };
});

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

const validateForeignTarget = createForeignTargetValidator();
const roots: string[] = [];
const backendBundle = 'handoff runner backend fixture';
const cliBundle = 'handoff runner cli fixture';
const claudeAppserverBundle = 'handoff runner claude appserver fixture';
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
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

function createTarget(): { readonly bundleDir: string; readonly target: ValidatedHandoffTarget } {
  const bundleDir = createBundle();
  const result = validateForeignTarget(bundleDir, manifest);
  if (result.kind !== 'validated') {
    throw new Error(`Fixture target failed validation: ${result.evidence.failure}`);
  }
  return { bundleDir, target: result.target };
}

function runnerRuntime(socketPath = join(tmpdir(), 'coral-handoff-runner.sock')): Pick<Runtime, 'env' | 'paths'> {
  const base = createRealRuntime('prod');
  return {
    env: {
      ...base.env,
      get: (key: string) => (key === 'CORAL_BASE_ENV' ? 'preserved' : undefined),
      cwd: () => '/handoff/cwd',
      fullSnapshot: () => ({ CORAL_BASE_ENV: 'preserved' }),
      coralSnapshot: () => ({ CORAL_BASE_ENV: 'preserved' }),
    },
    paths: {
      ...base.paths,
      coral: {
        ...base.paths.coral,
        coordinator: { ...base.paths.coral.coordinator, socketPath },
      },
    },
  };
}

function operation(entrypoint: HandoffOperation['entrypoint'] = 'cli'): HandoffOperation {
  return { entrypoint, args: ['status'], envAdditions: { CORAL_HANDOFF_TEST: '1' } };
}

function childThatExits(code: number | null, signal: NodeJS.Signals | null): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => {
    child.emit('spawn');
    queueMicrotask(() => child.emit('exit', code, signal));
  });
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  mockState.ensure.mockReset();
  mockState.spawn.mockReset();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff-runner', () => {
  it.each(['cli', 'backend'] as const)(
    'should execute the validated %s entrypoint with inherited stdio and return the newer version',
    async (entrypoint) => {
      const { bundleDir, target } = createTarget();
      mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

      const result = await runHandoff({ runtime: runnerRuntime(), target, operation: operation(entrypoint) });

      expect(result).toMatchObject({ kind: 'handoff-success', version: manifest.version });
      expect(mockState.spawn).toHaveBeenCalledWith(
        process.execPath,
        [join(bundleDir, `coral-${entrypoint}.cjs`), 'status'],
        expect.objectContaining({
          cwd: '/handoff/cwd',
          env: { CORAL_BASE_ENV: 'preserved', CORAL_HANDOFF_TEST: '1' },
          stdio: 'inherit',
        }),
      );
    },
  );

  it('should release a held canonical socket before spawning and retain the target lease through spawn', async () => {
    const { bundleDir, target } = createTarget();
    const socketPath = join(bundleDir, 'coordinator.sock');
    const lockPath = join(dirname(bundleDir), `.${basename(bundleDir)}.coral-target-execution.lock`);
    const order: string[] = [];
    const releaseCanonicalSocket = async () => {
      order.push('release');
    };
    mockState.spawn.mockImplementationOnce(() => {
      order.push('spawn');
      expect(existsSync(lockPath)).toBe(true);
      return childThatExits(0, null);
    });

    await runHandoff({
      runtime: runnerRuntime(socketPath),
      target,
      operation: operation(),
      releaseCanonicalSocket,
    });

    expect(order).toEqual(['release', 'spawn']);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('should not attempt a socket release when the caller holds no release capability', async () => {
    const { target } = createTarget();
    const socketPath = join(tmpdir(), 'coral-unheld.sock');
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await runHandoff({ runtime: runnerRuntime(socketPath), target, operation: operation() });

    expect(mockState.spawn).toHaveBeenCalledOnce();
  });

  it.each([
    ['cast', {} as ValidatedHandoffTarget],
    ['decoded', JSON.parse('{}') as unknown as ValidatedHandoffTarget],
  ])('should reject a %s target at the consumer boundary', async (_kind, target) => {
    await expect(runHandoff({ runtime: runnerRuntime(), target, operation: operation() })).rejects.toThrow(
      'was not produced',
    );
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should reject a target whose lease has expired', async () => {
    const { target } = createTarget();
    await withValidatedHandoffTarget(target, () => undefined);

    await expect(runHandoff({ runtime: runnerRuntime(), target, operation: operation() })).rejects.toThrow(
      'was not produced',
    );
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should validate the delegated operation before execution and release the target lease on failure', async () => {
    const { bundleDir, target } = createTarget();
    const lockPath = join(dirname(bundleDir), `.${basename(bundleDir)}.coral-target-execution.lock`);
    const invalidOperation = { entrypoint: 'shell', args: [] } as unknown as HandoffOperation;

    await expect(runHandoff({ runtime: runnerRuntime(), target, operation: invalidOperation })).rejects.toThrow();
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('should reject a byte mismatch at the final re-hash without spawning', async () => {
    const { bundleDir, target } = createTarget();
    writeFileSync(join(bundleDir, 'coral-cli.cjs'), 'changed after validation', 'utf8');

    await expect(runHandoff({ runtime: runnerRuntime(), target, operation: operation() })).rejects.toThrow(
      'bytes changed before execution',
    );
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should release the target lease when the child fails to spawn', async () => {
    const { bundleDir, target } = createTarget();
    const lockPath = join(dirname(bundleDir), `.${basename(bundleDir)}.coral-target-execution.lock`);
    mockState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    });

    await expect(runHandoff({ runtime: runnerRuntime(), target, operation: operation() })).rejects.toThrow(
      'spawn failed',
    );
    expect(existsSync(lockPath)).toBe(false);
  });

  it('should return a non-zero child exit code', async () => {
    const { target } = createTarget();
    mockState.spawn.mockImplementationOnce(() => childThatExits(23, null));

    await expect(runHandoff({ runtime: runnerRuntime(), target, operation: operation() })).resolves.toEqual({
      kind: 'handoff-exit',
      exitCode: 23,
    });
  });

  it('should return a child signal instead of treating it as a clean exit', async () => {
    const { target } = createTarget();
    mockState.spawn.mockImplementationOnce(() => childThatExits(null, 'SIGTERM'));

    await expect(runHandoff({ runtime: runnerRuntime(), target, operation: operation() })).resolves.toEqual({
      kind: 'handoff-signal',
      signal: 'SIGTERM',
    });
  });

  it('should resolve CLI routing without exposing the foreign validator', async () => {
    const routing = {
      kind: 'use-current',
      evidence: { source: 'current-build' },
    } satisfies BackendRoutingResult;
    const time = createRealRuntime('prod').time;
    mockState.ensure.mockResolvedValueOnce({ routing });

    await expect(resolveCliHandoffRouting('/plugin/root', time)).resolves.toBe(routing);
    expect(mockState.ensure).toHaveBeenCalledWith('/plugin/root', time, {
      validateForeignTarget: expect.any(Function),
    });
  });
});
