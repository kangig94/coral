import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

import {
  ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV,
  PdfMarkerConverter,
  USER_SOURCE_IMPORT_MAX_BYTES,
  deriveSourceImportReadPolicy,
  prepareSourceImport,
  resolveSourceImportFile,
  sourceImportAdminLimitExceededHint,
  type SourceImportRuntime,
} from '#src/kb/ops/source/import.js';
import { convertSourceInWorker } from '#src/kb/ops/source/conversion-worker.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ResourceBinding } from '#src/security/principal.js';

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function fakeRuntime(overrides: Partial<SourceImportRuntime> = {}): SourceImportRuntime {
  return {
    env: {
      fullSnapshot: () => ({ PATH: '/usr/bin' }),
      homedir: () => '/isolated-home',
      platform: () => 'linux',
    },
    process: {
      exec: async () => ({ stdout: '', stderr: '', status: 0 }),
    },
    ids: {
      uuid: () => 'fixed-source-import-id',
    },
    time: {
      now: () => Date.parse('2026-04-24T00:00:00.000Z'),
    },
    storage: createRealRuntime('prod').storage,
    ...overrides,
  };
}

function envWith(value?: string): { get(key: string): string | undefined } {
  return {
    get: (key) => (key === 'CORAL_KB_IMPORT_MAX_BYTES' ? value : undefined),
  };
}

function projectBinding(root: string): ResourceBinding {
  return { kind: 'project', root: fixtureCanonicalWorkDir(root) };
}

function unboundBinding(): ResourceBinding {
  return { kind: 'unbound' };
}

function coherentSizeStorage(size: number, isFile = true): SourceImportRuntime['storage'] {
  const realStorage = createRealRuntime('prod').storage;
  return {
    ...realStorage,
    realpathSync: (path) => path,
    statSync: (() => ({
      size,
      mtimeMs: 0,
      isDirectory: () => !isFile,
      isFile: () => isFile,
    })) as unknown as SourceImportRuntime['storage']['statSync'],
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('source import runtime isolation', () => {
  it('rejects traversal and root escapes under a user sandboxed policy', () => {
    const root = tempRoot('coral-source-import-traversal-');
    const projectRoot = join(root, 'project');
    const outside = join(root, 'outside.md');
    const policy = deriveSourceImportReadPolicy(projectBinding(projectRoot), projectRoot, envWith());
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(outside, '# Outside\n\nSecret\n', 'utf8');

    expect(() => resolveSourceImportFile('../outside.md', policy, fakeRuntime().storage)).toThrow(
      /must not contain "\.\."/,
    );
    expect(() => resolveSourceImportFile(outside, policy, fakeRuntime().storage)).toThrow(/must stay within/);
  });

  it('enforces user and admin source import caps through the read policy', () => {
    const adminReadableSize = USER_SOURCE_IMPORT_MAX_BYTES + 1;
    const adminPolicy = deriveSourceImportReadPolicy(
      unboundBinding(),
      '/project',
      envWith(String(adminReadableSize + 1)),
    );
    const userPolicy = deriveSourceImportReadPolicy(projectBinding('/project'), '/project', envWith());

    expect(resolveSourceImportFile('/outside/large.md', adminPolicy, coherentSizeStorage(adminReadableSize))).toEqual({
      path: '/outside/large.md',
    });
    expect(() =>
      resolveSourceImportFile('/project/large.md', userPolicy, coherentSizeStorage(USER_SOURCE_IMPORT_MAX_BYTES + 1)),
    ).toThrow(/exceeds maximum source import size/);
    expect(() =>
      resolveSourceImportFile('/outside/too-big.md', adminPolicy, coherentSizeStorage(adminReadableSize + 2)),
    ).toThrow(new RegExp(`exceeds maximum source import size.*${ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV}=<bytes>`));
  });

  it('rejects converted markdown output above the import byte cap with an admin override hint', async () => {
    const root = tempRoot('coral-source-import-output-cap-');
    const input = join(root, 'paper.md');
    const runtimeRoot = join(root, 'runtime');
    const runtime = fakeRuntime();
    const policy = deriveSourceImportReadPolicy(unboundBinding(), root, envWith('16'));
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# A\n', 'utf8');
    const sourceFile = resolveSourceImportFile(input, policy, runtime.storage);

    await expect(
      prepareSourceImport(sourceFile, undefined, policy.maxBytes, () => {}, runtimeRoot, runtime, {
        limitExceededHint: sourceImportAdminLimitExceededHint(),
      }),
    ).rejects.toThrow(new RegExp(`markdown output exceeds maximum size.*${ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV}=<bytes>`));
  });

  it('aborts source conversion workers before launch', async () => {
    const controller = new AbortController();
    controller.abort('user_abort');

    await expect(
      convertSourceInWorker(
        { kind: 'html', html: '<title>Ignored</title><p>Body</p>', outputMaxBytes: USER_SOURCE_IMPORT_MAX_BYTES },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      name: 'AbortError',
      code: 'aborted',
      stage: 'convert',
      reason: 'user_abort',
    });
  });
});

describe('PdfMarkerConverter separates "not installed" from "could not check"', () => {
  const ctx = (runtime: SourceImportRuntime) => ({
    runtime,
    runtimeRoot: '/isolated-runtime',
    fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
  });

  function locatorUnanswered(code: string): SourceImportRuntime {
    return fakeRuntime({
      process: {
        exec: async () => ({
          stdout: '',
          stderr: '',
          status: null,
          error: Object.assign(new Error(code), { code }),
        }),
      },
    });
  }

  it('reports an unanswered converter probe as undetermined', async () => {
    const code = 'EAGAIN';

    await expect(new PdfMarkerConverter().isAvailable(ctx(locatorUnanswered(code)))).resolves.toEqual({
      kind: 'undetermined',
      detail: code,
    });
  });
});
