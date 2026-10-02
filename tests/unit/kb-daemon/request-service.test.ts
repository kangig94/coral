import { join } from 'node:path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const searchMock = vi.hoisted(() => ({
  searchKb: vi.fn(async () => ({
    results: [
      {
        note: 'ko-contract',
        kind: 'note' as const,
        title: 'KO Contract',
        matchedBy: ['content' as const],
        tags: ['ko'],
        principles: [],
        evidence: [],
        snippet: '계약 검색 결과',
      },
    ],
    mode: 'text' as const,
    retrievalDiagnostics: [],
  })),
}));

vi.mock('#src/kb/ops/search.js', () => ({
  searchKb: searchMock.searchKb,
}));

import { createKbDaemonRequestService } from '#src/kb-daemon/request-service.js';
import { attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { epochDirectory, epochPath, storeEpochLockPath } from '#src/store/epoch/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
import type { PrincipalWire } from '#src/security/principal-wire.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const PROJECT_ROOT = fixtureCanonicalWorkDir(realpathSync(process.cwd()));
const tempDirs: string[] = [];

function principalWire(projectRoot: string): PrincipalWire {
  return {
    subject: 'operator' as const,
    binding: { kind: 'project' as const, root: fixtureCanonicalWorkDir(projectRoot) },
  };
}

function daemonCtx(projectRoot: string = PROJECT_ROOT, principal: PrincipalWire = principalWire(projectRoot)) {
  return { projectRoot: fixtureCanonicalWorkDir(projectRoot), pluginRoot: '/plugin', principal };
}

afterEach(() => {
  searchMock.searchKb.mockClear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('KB daemon request service', () => {
  it('denies a project-bound principal when a requested symlink escapes its canonical root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kb-canonical-'));
    tempDirs.push(root);
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    const link = join(allowed, 'link');
    mkdirSync(allowed);
    mkdirSync(outside);
    symlinkSync(outside, link, 'dir');
    const runtime = new SimulationRuntime();
    const read = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime }).read;

    const result = await read({
      method: 'listMemos',
      ctx: daemonCtx(link, principalWire(allowed)),
    });

    expect(result).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('should release the store epoch read lock once a diagnose request answers', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-kb-daemon-diagnose-'));
    tempDirs.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const storeFormat = currentCoralStoreFormat();
    const root = runtime.paths.coral.store.dbDir;
    mkdirSync(epochDirectory(root, '1'), { recursive: true });
    writeFileSync(storeEpochLockPath(root, '1'), '');
    openTestStoreDatabase({ path: epochPath(root, '1'), storage: runtime.storage, storeFormat }).close();
    writeFileSync(
      join(epochDirectory(root, '1'), 'epoch.json'),
      JSON.stringify({
        supersedes: null,
        classification: { kind: 'absent' },
        build: {
          version: storeFormat.productVersion,
          buildSetId: '123e4567-e89b-42d3-a456-426614174000',
          bundleHash: '0123456789abcdef',
          flavor: 'prod',
          storeFormatFingerprint: storeFormat.fingerprint,
        },
        publishedAt: '2026-09-25T00:00:00.000Z',
      }),
    );
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime });

    await expect(service.read({ method: 'diagnose', ctx: daemonCtx() })).resolves.toMatchObject({ ok: true });

    const attempt = attemptExclusiveFileLockSync(storeEpochLockPath(root, '1'));
    expect(attempt.kind).toBe('acquired');
    if (attempt.kind === 'acquired') attempt.lease();
  });

  it('returns kb_unavailable for write-backed mutations after the write runtime is disposed', async () => {
    const runtime = new SimulationRuntime();
    const writeRuntime = {
      withKb: vi.fn(async () => {
        throw new Error('write runtime should not be called');
      }),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: 'disposed' as const }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    await expect(
      service.mutate({
        method: 'updateNote',
        args: { note: 'alpha-note' },
        ctx: {
          projectRoot: PROJECT_ROOT,
          pluginRoot: '/plugin',
          principal: principalWire(PROJECT_ROOT),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      message: expect.stringContaining('disposed'),
    });
    expect(writeRuntime.withKb).not.toHaveBeenCalled();
  });

  it('fails kb search fast and starts write-runtime warmup when search is still cold', async () => {
    const runtime = new SimulationRuntime();
    const writeRuntime = {
      withKb: vi.fn(async () => {
        throw new Error('write runtime search should not run while cold');
      }),
      warmSearchRuntime: vi.fn(),
      searchReadiness: vi.fn(() => ({
        ready: false as const,
        reason: 'write_runtime_initializing',
        message: 'KB search runtime is still warming.',
      })),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: 'not_initialized' as const }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    const result = await service.read({
      method: 'readSearch',
      args: { query: '계약' },
      ctx: daemonCtx(),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'kb_search_runtime_not_ready',
      message: 'KB search runtime is still warming.',
      detail: { reason: 'write_runtime_initializing' },
    });
    expect(writeRuntime.warmSearchRuntime).toHaveBeenCalledTimes(1);
    expect(writeRuntime.withKb).not.toHaveBeenCalled();
  });
});
