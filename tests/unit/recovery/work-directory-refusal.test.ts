import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { toProviderRequest } from '#src/jobs/provider-request.js';
import type { ProviderJobLaunch } from '#src/jobs/records.js';
import { resolveCodexHostCwd } from '#src/providers/codex/request-mapping.js';
import { canonicalizeWorkDir, WorkDirectoryError } from '#src/runtime/canonical-work-dir.js';

const tempDirs: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-recovery-work-dir-refusal-'));
  tempDirs.push(root);
  return root;
}

function expectPersistedRecoveryRefusal(
  boundary: string,
  workDir: string,
  baseDir: string,
  decode: () => unknown,
): void {
  try {
    decode();
    expect.fail(
      `AC11 silent divergence at the persisted-recovery ${boundary}: an unresolvable work directory was accepted`,
    );
  } catch (error: unknown) {
    if (!(error instanceof WorkDirectoryError)) throw error;
    expect(error).toMatchObject({
      code: 'invalid_work_directory',
      workDir,
      baseDir,
    });
    expect(error.message).toContain(workDir);
    expect(error.message).toMatch(/ENOENT|no such file or directory/);
  }
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('persisted recovery work-directory decoding', () => {
  it('refuses an unresolvable cwd in a recovered provider launch record', () => {
    const projectRoot = canonicalizeWorkDir(tempProject(), process.cwd());
    const persistedCwd = join(projectRoot, 'deleted-provider-cwd');
    const launch: ProviderJobLaunch = {
      jobId: 'job-recovered',
      owner: { kind: 'provider-session', id: 'session-recovered' },
      sessionId: 'session-recovered',
      provider: 'codex',
      providerAction: 'resume',
      projectRoot,
      backendNamespace: 'test-backend',
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 1,
      request: {
        prompt: 'continue',
        cwd: persistedCwd,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: '2026-08-12T00:00:00.000Z',
    };

    expectPersistedRecoveryRefusal('provider-launch boundary', persistedCwd, projectRoot, () =>
      toProviderRequest(launch, 'thread-recovered'),
    );
  });

  it('refuses an unresolvable cwd in persisted Codex continuity', () => {
    const requestCwd = canonicalizeWorkDir(tempProject(), process.cwd());
    const persistedCwd = join(requestCwd, 'deleted-continuity-cwd');

    expectPersistedRecoveryRefusal('Codex-continuity boundary', persistedCwd, requestCwd, () =>
      resolveCodexHostCwd(requestCwd, { cwd: persistedCwd, threadId: 'thread-recovered' }),
    );
  });
});
