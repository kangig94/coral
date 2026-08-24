import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { socketFallbackDir } from '#src/infra/path/unix-socket.js';
import { acquireOperatorSocketGuard } from '#src/cli/operator-socket-guard.js';
import { discardHandoffRoutingStatus } from '#src/cli/routing-status-discard.js';
import { quarantineKbCommit } from '#src/cli/kb-commit-quarantine.js';
import { acquireStoreResetSocketGuard } from '#src/cli/store-reset-socket.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { resolveStoreResetTargetPaths } from '#src/store/operator-store-reset.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'coral-operator-socket-bind-'));
  roots.push(value);
  return value;
}

function blockSocketParent(socketPath: string): void {
  const parent = dirname(socketPath);
  mkdirSync(dirname(parent), { recursive: true });
  writeFileSync(parent, 'not-a-directory', 'utf-8');
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('operator coordinator socket bind failures', () => {
  // The generic wrapper below is for a bind failure this command cannot classify. One that already carries a
  // documented code carries its own remediation and its own exit class, and re-wrapping puts "could not
  // observe" back under the exit-1 verdict the split exists to separate it from.
  it('passes a documented bind refusal through instead of rewrapping it', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(Number.NaN);

    let refusal: unknown;
    try {
      await acquireOperatorSocketGuard({
        socketPath: join(socketFallbackDir(Number.NaN), 'coordinator.sock'),
        flavor: 'prod',
        operation: 'store reset',
        retryCommand: 'retry',
      });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({ code: 'coordinator_socket_dir_unverified' });
  });

  it.each(['store-reset', 'kb-commit'] as const)('translates a non-EADDRINUSE bind failure for %s', async (command) => {
    const runtime = createRealRuntime('prod', { baseDir: root() });
    blockSocketParent(runtime.paths.coral.coordinator.socketPath);

    let refusal: unknown;
    try {
      if (command === 'store-reset') {
        await acquireStoreResetSocketGuard(resolveStoreResetTargetPaths(runtime, 'gen2'), runtime.flavor);
      } else {
        await quarantineKbCommit({ runtime, commitId: 'blocking-commit' });
      }
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({
      code: 'coordinator_socket_bind_failed',
      remediation: expect.stringContaining('coral-cli backend shutdown'),
      context: {
        socketPath: runtime.paths.coral.coordinator.socketPath,
        cause: expect.stringMatching(/directory|EEXIST|ENOTDIR/u),
      },
    });
  });

  it('returns an unobservable discard refusal for a coordinator socket bind failure', async () => {
    const runtime = createRealRuntime('prod', { baseDir: root() });
    const path = join(runtime.paths.coral.coordinator.runDir, 'handoff-routing.1.db');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    const socketPath = join(root(), 'blocked-parent', 'coordinator.sock');
    blockSocketParent(socketPath);
    const guardedRuntime = {
      ...runtime,
      paths: {
        ...runtime.paths,
        coral: {
          ...runtime.paths.coral,
          coordinator: { ...runtime.paths.coral.coordinator, socketPath },
        },
      },
    };

    await expect(discardHandoffRoutingStatus(guardedRuntime, path)).resolves.toEqual({
      kind: 'coordinator-socket-unobservable',
      socketPath,
      cause: 'bind-failed',
    });
  });
});
