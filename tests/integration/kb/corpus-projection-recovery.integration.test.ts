import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { quarantineKbCommit } from '#src/cli/kb-commit-quarantine.js';
import { registerBackendCommands } from '#src/cli/commands/backend.js';
import type { KbCommitQuarantineResult } from '#src/kb/commit-quarantine.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { captureIndexStateSnapshot } from '#src/kb/corpus/lanes.js';
import type { StagedCorpusProjection } from '#src/kb/corpus/projection-lifecycle.js';
import { CoralSetupError, serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { bindSocket } from '#src/transport/ipc/server.js';

const tempRoots: string[] = [];
const openDatabases: Database[] = [];

type ProjectionHarness = {
  root: string;
  runtimeDir: string;
  db: Database;
  kb: KbRuntime;
  runtime: Runtime;
};

function createHarness(): ProjectionHarness {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-projection-lifecycle-'));
  const runtime = createRealRuntime('prod', { baseDir: root });
  const runtimeDir = runtime.paths.coral.kbRuntime.root;
  const markdownRoot = join(root, 'vault');
  mkdirSync(join(markdownRoot, 'notes'), { recursive: true });
  tempRoots.push(root);
  const db = createKbTestDb(runtimeDir);
  openDatabases.push(db);
  const { kb } = createKbTestRuntime({ markdownRoot, runtimeDir, db, runtime });
  return { root: markdownRoot, runtimeDir, db, kb, runtime };
}

function closeHarnessDatabase(input: ProjectionHarness): void {
  input.db.close();
  const index = openDatabases.indexOf(input.db);
  if (index >= 0) {
    openDatabases.splice(index, 1);
  }
}

function openHarness(input: ProjectionHarness): { db: Database; kb: KbRuntime } {
  const db = createKbTestDb(input.runtimeDir);
  openDatabases.push(db);
  const { kb } = createKbTestRuntime({
    markdownRoot: input.root,
    runtimeDir: input.runtimeDir,
    db,
    runtime: input.runtime,
  });
  return { db, kb };
}

function shutdownCoordinator(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeNote(root: string, slug: string, body: string): void {
  writeFileSync(
    join(root, 'notes', `${slug}.md`),
    [
      '---',
      'tags: [projection]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-06-01T00:00:00.000Z',
      'updatedAt: 2026-06-01T00:00:00.000Z',
      'entrySeq: 1',
      '---',
      '# Projection Note',
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function createInterruptedPendingProjection(harness: ProjectionHarness): Promise<StagedCorpusProjection> {
  const { deriveCorpusProjection, stageCorpusProjectionArtifacts, commitCorpusProjection } =
    await import('#src/kb/corpus/rescan/index.js');
  writeNote(harness.root, 'blocking-commit', 'Blocking commit evidence.');
  const candidate = await deriveCorpusProjection(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState()));
  const staged = stageCorpusProjectionArtifacts(harness.kb, candidate);
  await expect(
    commitCorpusProjection(harness.kb, staged, { faultInjection: { failAfterPhase: 'pending' } }),
  ).rejects.toThrow(/Injected corpus projection commit fault/);
  return staged;
}

function refuseHarnessBoot(input: ProjectionHarness): CoralSetupError {
  closeHarnessDatabase(input);
  const db = createKbTestDb(input.runtimeDir);
  openDatabases.push(db);
  input.db = db;
  try {
    createKbTestRuntime({
      markdownRoot: input.root,
      runtimeDir: input.runtimeDir,
      db,
      runtime: input.runtime,
    });
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoralSetupError);
    return error as CoralSetupError;
  }
  throw new Error('Expected KB boot to refuse the blocking corpus projection commit.');
}

async function runQuarantineCommand(harness: ProjectionHarness, commitId: string): Promise<KbCommitQuarantineResult> {
  let result: KbCommitQuarantineResult | null = null;
  const program = new Command();
  program.exitOverride();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  registerBackendCommands(
    program,
    {
      list: () => ({ incidents: [] }),
      report: async () => {
        throw new Error('Store reset is not part of KB commit recovery.');
      },
      discard: async () => {
        throw new Error('Store reset is not part of KB commit recovery.');
      },
    },
    {
      quarantine: async (flavor, blockingCommitId) => {
        expect(flavor).toBe('prod');
        result = await quarantineKbCommit({ runtime: harness.runtime, commitId: blockingCommitId });
        return result;
      },
    },
  );

  try {
    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'kb-commit',
      'quarantine',
      '--flavor',
      'prod',
      '--commit',
      commitId,
    ]);
  } finally {
    stdout.mockRestore();
  }

  if (result === null) {
    throw new Error('KB commit quarantine command did not produce a result.');
  }
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of openDatabases.splice(0).reverse()) {
    db.close();
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('corpus projection recovery', () => {
  it('recovers refusal through explicit KB commit quarantine and then boots successfully', async () => {
    const harness = createHarness();
    const staged = await createInterruptedPendingProjection(harness);
    const commitDirectory = join(harness.runtimeDir, 'corpus-projection', 'commits', staged.commitId);
    const indexCommitDirectory = join(harness.runtimeDir, 'corpus-projection', 'index', 'commits', staged.commitId);
    writeFileSync(join(commitDirectory, 'commit.json'), '{malformed-recovery-record', 'utf-8');

    const refusal = refuseHarnessBoot(harness);
    expect(refusal.code).toBe('kb_commit_corrupt_or_unsupported');
    const shutdownStep = refusal.remediation.indexOf('coral-cli backend shutdown');
    const quarantineStep = refusal.remediation.indexOf('coral-cli backend kb-commit quarantine');
    expect(shutdownStep).toBeGreaterThanOrEqual(0);
    expect(quarantineStep).toBeGreaterThan(shutdownStep);
    closeHarnessDatabase(harness);
    const storePath = join(harness.runtimeDir, 'store.db');
    const storeBefore = readFileSync(storePath);

    const coordinator = createServer();
    await expect(bindSocket(coordinator, harness.runtime.paths.coral.coordinator.socketPath)).resolves.toEqual({
      kind: 'bound',
    });
    try {
      let quarantineWhileRunning: unknown;
      try {
        await quarantineKbCommit({ runtime: harness.runtime, commitId: staged.commitId });
      } catch (error: unknown) {
        quarantineWhileRunning = error;
      }
      expect(serializeCoralSetupError(quarantineWhileRunning)).toMatchObject({
        code: 'coordinator_socket_in_use',
        remediation: expect.stringContaining('coral-cli backend shutdown'),
      });
    } finally {
      await shutdownCoordinator(coordinator);
    }

    const quarantine = await runQuarantineCommand(harness, staged.commitId);

    expect(quarantine.artifacts).toEqual(['commit', 'index']);
    expect(existsSync(commitDirectory)).toBe(false);
    expect(existsSync(indexCommitDirectory)).toBe(false);
    expect(readFileSync(join(quarantine.quarantineDir, 'commit', 'commit.json'), 'utf-8')).toBe(
      '{malformed-recovery-record',
    );
    expect(JSON.parse(readFileSync(join(quarantine.quarantineDir, 'manifest.json'), 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      commitId: staged.commitId,
      artifacts: ['commit', 'index'],
    });
    expect(readFileSync(storePath)).toEqual(storeBefore);

    const reopened = openHarness(harness);
    harness.db = reopened.db;
    harness.kb = reopened.kb;
    expect(harness.kb.readIndex()).toBeNull();
  });
});
