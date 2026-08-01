import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { quarantineKbCommit } from '#src/cli/kb-commit-quarantine.js';
import { acquireStoreAdoptionSocketGuard } from '#src/cli/store-adopt.js';
import { acquireStoreResetSocketGuard, resolveStoreResetTargetPaths } from '#src/cli/store-reset.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';

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
});

describe('operator coordinator socket bind failures', () => {
  it.each(['store-adopt', 'store-reset', 'kb-commit'] as const)(
    'translates a non-EADDRINUSE bind failure for %s',
    async (command) => {
      const runtime = createRealRuntime('prod', { baseDir: root() });
      blockSocketParent(runtime.paths.coral.coordinator.socketPath);

      let refusal: unknown;
      try {
        if (command === 'store-adopt') {
          await acquireStoreAdoptionSocketGuard(runtime.paths.coral.coordinator.socketPath, runtime.flavor);
        } else if (command === 'store-reset') {
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
    },
  );
});
