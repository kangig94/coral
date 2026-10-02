import { testIncarnation } from '#tests/helpers/process-incarnation.js';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { quarantineKbCommit } from '#src/cli/kb-commit-quarantine.js';
import { KB_RUNTIME_AUTHORITY } from '#src/runtime/kb-runtime-authority.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { generationMutationCoordinationSeam } from '#src/store/generation-mutation-coordination.js';

const roots: string[] = [];

function createHarness(): { readonly root: string; readonly runtime: Runtime; readonly commitId: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-commit-quarantine-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const commitId = 'blocking-commit';
  const projectionRoot = join(runtime.paths.coral.kbRuntime.root, KB_RUNTIME_AUTHORITY.corpusProjection);
  const commitDirectory = join(projectionRoot, 'commits', commitId);
  const indexDirectory = join(projectionRoot, 'index', 'commits', commitId);
  mkdirSync(commitDirectory, { recursive: true });
  mkdirSync(indexDirectory, { recursive: true });
  writeFileSync(join(commitDirectory, 'commit.json'), '{malformed', 'utf-8');
  writeFileSync(join(indexDirectory, 'previous-index.json'), 'index-evidence', 'utf-8');
  return { root, runtime, commitId };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('KB commit quarantine', () => {
  it('refuses without mutation while a generation writer lease is live', async () => {
    const { runtime: realRuntime, commitId } = createHarness();
    const incarnation = testIncarnation(realRuntime.env.pid());
    let now = realRuntime.time.now();
    const runtime: Runtime = {
      ...realRuntime,
      process: {
        ...realRuntime.process,
        readProcessIncarnation: () => incarnation,
        observeLiveness: () => 'alive',
      },
      time: {
        ...realRuntime.time,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    };
    const commitDirectory = join(
      runtime.paths.coral.kbRuntime.root,
      KB_RUNTIME_AUTHORITY.corpusProjection,
      'commits',
      commitId,
    );
    const readiness = await generationMutationCoordinationSeam.completeReadiness(runtime, {
      kind: 'kb-child',
      name: 'orphaned-kb-daemon',
    });
    readiness.release();
    const writer = await generationMutationCoordinationSeam.acquireWriterLease(runtime, {
      kind: 'kb-child',
      name: 'orphaned-kb-daemon',
    });

    try {
      let refusal: unknown;
      try {
        await quarantineKbCommit({ runtime, commitId, maintenanceTimeoutMs: 10 });
      } catch (error: unknown) {
        refusal = error;
      }
      expect(serializeCoralSetupError(refusal)).toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: { operation: 'kb-commit', holder: expect.stringContaining('orphaned-kb-daemon') },
      });
      expect(readFileSync(join(commitDirectory, 'commit.json'), 'utf-8')).toBe('{malformed');
    } finally {
      writer.release();
    }
  });
});
