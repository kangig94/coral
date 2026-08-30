import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { socketFallbackDir } from '#src/infra/path/unix-socket.js';
import { v0109CoordinatorSocketGuardSetForRunDir } from '#src/infra/path/coordinator.js';
import { acquireOperatorSocketGuard } from '#src/cli/operator-socket-guard.js';
import { discardHandoffRoutingStatus } from '#src/cli/routing-status-discard.js';
import { handoffRoutingStatusStoreSchema } from '#src/coordinator/handoff-routing/status.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import { quarantineKbCommit } from '#src/cli/kb-commit-quarantine.js';
import { acquireStoreResetSocketGuard } from '#src/cli/store-reset-socket.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { resolveStoreResetTargetPaths } from '#src/store/operator-store-reset.js';
import { bindSocket } from '#src/transport/ipc/server.js';

const roots: string[] = [];
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());

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

async function holdSocket(socketPath: string): Promise<Server> {
  const server = createServer();
  const binding = await bindSocket(server, socketPath);
  if (binding.kind === 'incumbent') throw new Error(`Test socket already held: ${socketPath}`);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function publishSocket(runtime: ReturnType<typeof createRealRuntime>, socketPath: string): void {
  mkdirSync(dirname(runtime.paths.coral.coordinator.infoFile), { recursive: true });
  writeFileSync(
    runtime.paths.coral.coordinator.infoFile,
    JSON.stringify({
      pid: process.pid,
      port: 1,
      socketPath,
      bundleHash: 'published-bundle',
      flavor: runtime.flavor,
      namespace: 'operator-socket-guard-test',
      startedAt: 1,
      token: 'operator-token',
      bootToken: 'boot-token',
    }),
    'utf-8',
  );
}

function publishedLegacySocketPath(runtime: ReturnType<typeof createRealRuntime>, directory: string): string {
  const legacy = v0109CoordinatorSocketGuardSetForRunDir(runtime.paths.coral.coordinator.runDir, runtime.flavor, {
    platform: runtime.env.platform(),
    configuredTempDirectory: directory,
    systemTempDirectory: directory,
  });
  if (legacy.kind !== 'guarded-addresses' || legacy.paths[0] === undefined) {
    throw new Error('Test state root did not produce a shipped compatibility address');
  }
  return legacy.paths[0];
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
    const runtime = createRealRuntime('prod', { baseDir: root() });
    const socketPath = join(socketFallbackDir('/state/unusable-owner'), 'coordinator.sock');
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

    let refusal: unknown;
    try {
      await acquireOperatorSocketGuard({
        runtime: guardedRuntime,
        operation: 'store reset',
        retryCommand: 'retry',
      });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({ code: 'coordinator_socket_dir_unverified' });
  });

  it.each(['store-reset', 'kb-commit'] as const)(
    'refuses without a verdict when the run directory cannot be read for %s',
    async (command) => {
      const runtime = createRealRuntime('prod', { baseDir: root() });
      blockSocketParent(runtime.paths.coral.coordinator.socketPath);

      let refusal: unknown;
      try {
        if (command === 'store-reset') {
          await acquireStoreResetSocketGuard(resolveStoreResetTargetPaths(runtime, 'gen2'), runtime);
        } else {
          await quarantineKbCommit({ runtime, commitId: 'blocking-commit' });
        }
      } catch (error: unknown) {
        refusal = error;
      }

      // A broken run directory is met before any bind: the guard cannot read whether an incumbent exists, and
      // a destructive command must stop on that rather than on the later bind failure.
      expect(serializeCoralSetupError(refusal)).toMatchObject({
        code: 'coordinator_record_unreadable',
        context: { detail: expect.stringMatching(/directory|EEXIST|ENOTDIR/u) },
      });
    },
  );

  it.each(['published', 'legacy'] as const)(
    'refuses a destructive command while only the %s coordinator address is held',
    async (addressKind) => {
      const baseDir = join(root(), 'state-root-long-enough-to-relocate-'.repeat(4));
      const runtime = createRealRuntime('prod', { baseDir });
      let heldSocketPath: string;
      if (addressKind === 'published') {
        heldSocketPath = publishedLegacySocketPath(runtime, root());
        publishSocket(runtime, heldSocketPath);
      } else {
        const legacy = v0109CoordinatorSocketGuardSetForRunDir(runtime.paths.coral.coordinator.runDir, runtime.flavor, {
          platform: runtime.env.platform(),
          configuredTempDirectory: runtime.env.get('TMPDIR'),
          systemTempDirectory: runtime.env.tmpdir(),
        });
        if (legacy.kind !== 'guarded-addresses' || legacy.paths[0] === undefined) {
          throw new Error('Test state root did not produce a shipped compatibility address');
        }
        heldSocketPath = legacy.paths[0];
      }
      const incumbent = await holdSocket(heldSocketPath);

      try {
        let refusal: unknown;
        try {
          await quarantineKbCommit({ runtime, commitId: 'blocked-by-coordinator' });
        } catch (error: unknown) {
          refusal = error;
        }

        expect(serializeCoralSetupError(refusal)).toMatchObject({
          code: 'coordinator_socket_in_use',
          context: { socketPath: heldSocketPath },
        });
      } finally {
        await closeServer(incumbent);
      }
    },
  );

  it('leaves a non-socket published address in place and refuses the guard', async () => {
    const runtime = createRealRuntime('prod', {
      baseDir: join(root(), 'state-root-long-enough-to-relocate-'.repeat(4)),
    });
    const publishedSocketPath = publishedLegacySocketPath(runtime, root());
    writeFileSync(publishedSocketPath, 'sentinel', 'utf-8');
    publishSocket(runtime, publishedSocketPath);

    let refusal: unknown;
    try {
      await acquireOperatorSocketGuard({ runtime, operation: 'store reset', retryCommand: 'retry' });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({
      code: 'coordinator_socket_bind_failed',
      context: { cause: expect.stringContaining('is not a socket') },
    });
    expect(existsSync(publishedSocketPath)).toBe(true);
  });

  it('does not create parents for a published address outside Coral namespace', async () => {
    const runtime = createRealRuntime('prod', {
      baseDir: join(root(), 'state-root-long-enough-to-relocate-'.repeat(4)),
    });
    const outsideParent = join(root(), 'outside', 'missing');
    const publishedSocketPath = join(outsideParent, 'sentinel');
    publishSocket(runtime, publishedSocketPath);

    let refusal: unknown;
    try {
      await acquireOperatorSocketGuard({ runtime, operation: 'store reset', retryCommand: 'retry' });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({
      code: 'coordinator_record_unreadable',
      context: { detail: expect.stringContaining("outside Coral's coordinator namespace") },
    });
    expect(existsSync(outsideParent)).toBe(false);
  });

  it('does not delete an existing published path outside Coral namespace', async () => {
    const runtime = createRealRuntime('prod', {
      baseDir: join(root(), 'state-root-long-enough-to-relocate-'.repeat(4)),
    });
    const publishedSocketPath = join(root(), 'sentinel');
    writeFileSync(publishedSocketPath, 'sentinel', 'utf-8');
    publishSocket(runtime, publishedSocketPath);

    let refusal: unknown;
    try {
      await acquireOperatorSocketGuard({ runtime, operation: 'store reset', retryCommand: 'retry' });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({ code: 'coordinator_record_unreadable' });
    expect(existsSync(publishedSocketPath)).toBe(true);
  });

  it('refuses before binding when a shipped compatibility address is unenumerable', async () => {
    const runtime = createRealRuntime('prod', {
      baseDir: join(root(), 'state-root-long-enough-to-relocate-'.repeat(4)),
    });
    const guardedRuntime = {
      ...runtime,
      env: {
        ...runtime.env,
        get: (name: string) => (name === 'TMPDIR' ? 'relative-selector' : runtime.env.get(name)),
      },
    };

    let acquired: Awaited<ReturnType<typeof acquireOperatorSocketGuard>> | null = null;
    let refusal: unknown;
    try {
      acquired = await acquireOperatorSocketGuard({
        runtime: guardedRuntime,
        operation: 'store reset',
        retryCommand: 'retry',
      });
    } catch (error: unknown) {
      refusal = error;
    }

    try {
      expect(serializeCoralSetupError(refusal)).toMatchObject({
        code: 'coordinator_socket_bind_failed',
        context: { cause: expect.stringContaining('Cannot enumerate the shipped v0.10.9 coordinator socket') },
      });
    } finally {
      await acquired?.release();
    }
  });

  it('releases earlier addresses when a later address is already held', async () => {
    const runtime = createRealRuntime('prod', {
      baseDir: join(root(), 'state-root-long-enough-to-relocate-'.repeat(4)),
    });
    const publishedSocketPath = publishedLegacySocketPath(runtime, root());
    publishSocket(runtime, publishedSocketPath);
    const incumbent = await holdSocket(publishedSocketPath);
    const probe = createServer();

    try {
      await expect(
        acquireOperatorSocketGuard({
          runtime,
          operation: 'store reset',
          retryCommand: 'retry',
        }),
      ).rejects.toMatchObject({ code: 'coordinator_socket_in_use' });

      await expect(bindSocket(probe, runtime.paths.coral.coordinator.socketPath)).resolves.toMatchObject({
        kind: 'bound',
      });
    } finally {
      await closeServer(probe);
      await closeServer(incumbent);
    }
  });

  it('returns an unobservable discard refusal for a coordinator socket bind failure', async () => {
    const runtime = createRealRuntime('prod', { baseDir: root() });
    const path = join(
      runtime.paths.coral.coordinator.runDir,
      `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
    );
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
