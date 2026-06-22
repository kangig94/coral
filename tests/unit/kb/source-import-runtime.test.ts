import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT,
  PdfMarkerConverter,
  USER_SOURCE_IMPORT_MAX_BYTES,
  deriveSourceImportReadPolicy,
  prepareSourceImport,
  resolveAdminSourceImportCap,
  resolveSourceImportFile,
  type SourceImportReadPolicy,
  type SourceImportRuntime,
} from '#src/kb/ops/source-import.js';
import { kbSourceImportSchema } from '#src/kb/tool-contracts.js';
import { createRealRuntime } from '#src/runtime/real.js';

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

function storageWithReadSpy(): {
  storage: SourceImportRuntime['storage'];
  readFile: ReturnType<typeof vi.fn<(path: string, encoding: 'utf-8') => Promise<string>>>;
} {
  const realStorage = createRealRuntime('prod').storage;
  const readFile = vi.fn((path: string, encoding: 'utf-8') => realStorage.readFile(path, encoding));
  return {
    storage: { ...realStorage, readFile },
    readFile,
  };
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
  it('accepts parent path segments at the tool-contract boundary', () => {
    expect(kbSourceImportSchema.safeParse({ filePath: '../outside.md' }).success).toBe(true);
  });

  it('derives source import read policies and admin caps from authority and env', () => {
    expect(resolveAdminSourceImportCap(envWith())).toBe(ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT);
    expect(resolveAdminSourceImportCap(envWith('4096'))).toBe(4096);
    expect(resolveAdminSourceImportCap(envWith('0'))).toBeNull();
    expect(resolveAdminSourceImportCap(envWith('unlimited'))).toBeNull();
    expect(resolveAdminSourceImportCap(envWith('abc'))).toBe(ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT);

    expect(deriveSourceImportReadPolicy('user', '/project', envWith('4096'))).toEqual({
      kind: 'sandboxed',
      root: '/project',
      maxBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });
    expect(deriveSourceImportReadPolicy('admin', '/project', envWith('4096'))).toEqual({
      kind: 'unrestricted',
      resolveBase: '/project',
      maxBytes: 4096,
    });
  });

  it('uses injected ids and time when staging markdown imports', async () => {
    const root = tempRoot('coral-source-import-runtime-');
    const input = join(root, 'paper.md');
    const runtimeRoot = join(root, 'runtime');
    const { storage, readFile } = storageWithReadSpy();
    const runtime = fakeRuntime({ storage });
    const policy = deriveSourceImportReadPolicy('user', root, envWith());
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# Runtime Isolated\n\nBody\n', 'utf8');
    const sourceFile = resolveSourceImportFile(input, policy, runtime.storage);

    const prepared = await prepareSourceImport(
      sourceFile,
      undefined,
      policy.maxBytes,
      () => {},
      runtimeRoot,
      runtime,
      {},
    );

    expect(prepared.stagedPath).toBe(join(runtimeRoot, 'source-import-staging', 'fixed-source-import-id.md'));
    expect(readFileSync(prepared.stagedPath, 'utf8')).toContain('importedAt: 2026-04-24T00:00:00.000Z');
    expect(readFile).toHaveBeenCalledWith(input, 'utf-8');
  });

  it('rejects traversal and root escapes under a user sandboxed policy', () => {
    const root = tempRoot('coral-source-import-traversal-');
    const projectRoot = join(root, 'project');
    const outside = join(root, 'outside.md');
    const policy = deriveSourceImportReadPolicy('user', projectRoot, envWith());
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(outside, '# Outside\n\nSecret\n', 'utf8');

    expect(() => resolveSourceImportFile('../outside.md', policy, fakeRuntime().storage)).toThrow(
      /must not contain "\.\."/,
    );
    expect(() => resolveSourceImportFile(outside, policy, fakeRuntime().storage)).toThrow(/must stay within/);
  });

  it('allows an admin unrestricted policy to resolve an out-of-tree absolute path', () => {
    const storage = coherentSizeStorage(1);
    const policy = deriveSourceImportReadPolicy('admin', '/project', envWith());

    expect(resolveSourceImportFile('/outside/source.md', policy, storage)).toEqual({ path: '/outside/source.md' });
  });

  it('enforces user and admin source import caps through the read policy', () => {
    const adminReadableSize = USER_SOURCE_IMPORT_MAX_BYTES + 1;
    const adminPolicy = deriveSourceImportReadPolicy('admin', '/project', envWith(String(adminReadableSize + 1)));
    const userPolicy = deriveSourceImportReadPolicy('user', '/project', envWith());

    expect(resolveSourceImportFile('/outside/large.md', adminPolicy, coherentSizeStorage(adminReadableSize))).toEqual({
      path: '/outside/large.md',
    });
    expect(() =>
      resolveSourceImportFile('/project/large.md', userPolicy, coherentSizeStorage(USER_SOURCE_IMPORT_MAX_BYTES + 1)),
    ).toThrow(/exceeds maximum source import size/);
    expect(() =>
      resolveSourceImportFile('/outside/too-big.md', adminPolicy, coherentSizeStorage(adminReadableSize + 2)),
    ).toThrow(/exceeds maximum source import size/);
  });

  it('skips byte comparison for admin-unlimited imports but still rejects non-files', () => {
    const policy = deriveSourceImportReadPolicy('admin', '/project', envWith('0'));

    expect(policy).toEqual({ kind: 'unrestricted', resolveBase: '/project', maxBytes: null });
    expect(
      resolveSourceImportFile('/outside/huge.md', policy, coherentSizeStorage(USER_SOURCE_IMPORT_MAX_BYTES * 4)),
    ).toEqual({
      path: '/outside/huge.md',
    });
    expect(() =>
      resolveSourceImportFile(
        '/outside/directory',
        policy,
        coherentSizeStorage(USER_SOURCE_IMPORT_MAX_BYTES * 4, false),
      ),
    ).toThrow(/must be a file/);
  });

  it('checks custom policy maxBytes before reading source files', () => {
    const policy: SourceImportReadPolicy = { kind: 'unrestricted', resolveBase: '/project', maxBytes: 8 };

    expect(() => resolveSourceImportFile('/project/large.md', policy, coherentSizeStorage(9))).toThrow(
      /exceeds maximum source import size/,
    );
  });

  it('accepts an absolute source path inside the allowed project root', async () => {
    const root = tempRoot('coral-source-import-in-scope-');
    const projectRoot = join(root, 'project');
    const runtimeRoot = join(root, 'runtime');
    const input = join(projectRoot, 'paper.md');
    const runtime = fakeRuntime();
    const policy = deriveSourceImportReadPolicy('user', projectRoot, envWith());
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# In Scope\n\nBody\n', 'utf8');
    const sourceFile = resolveSourceImportFile(input, policy, runtime.storage);

    const prepared = await prepareSourceImport(
      sourceFile,
      undefined,
      policy.maxBytes,
      () => {},
      runtimeRoot,
      runtime,
      {},
    );

    expect(readFileSync(prepared.stagedPath, 'utf8')).toContain('# In Scope\n\nBody');
  });

  it('stages HTML imports through async storage reads', async () => {
    const root = tempRoot('coral-source-import-html-');
    const input = join(root, 'paper.html');
    const runtimeRoot = join(root, 'runtime');
    const { storage, readFile } = storageWithReadSpy();
    const runtime = fakeRuntime({ storage });
    const policy = deriveSourceImportReadPolicy('user', root, envWith());
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(
      input,
      '<html><head><title>HTML Import</title></head><body><h1>HTML Import</h1><p>Body &amp; details</p></body></html>',
      'utf8',
    );
    const sourceFile = resolveSourceImportFile(input, policy, runtime.storage);

    const prepared = await prepareSourceImport(
      sourceFile,
      undefined,
      policy.maxBytes,
      () => {},
      runtimeRoot,
      runtime,
      {},
    );
    const staged = readFileSync(prepared.stagedPath, 'utf8');

    expect(staged).toContain('# HTML Import');
    expect(staged).toContain('Body & details');
    expect(readFile).toHaveBeenCalledWith(input, 'utf-8');
  });

  it('parses marker output through async storage reads', async () => {
    const root = tempRoot('coral-source-import-marker-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const { storage, readFile } = storageWithReadSpy();
    const runtime = fakeRuntime({
      storage,
      process: {
        exec: async (command, args) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/marker_single') {
            const outputDirFlagIndex = args.indexOf('--output_dir');
            const outputDir = args[outputDirFlagIndex + 1];
            mkdirSync(outputDir, { recursive: true });
            writeFileSync(join(outputDir, 'output.md'), '# PDF Import\n\nMarker body\n', 'utf8');
            return { stdout: '', stderr: '', status: 0 };
          }
          return { stdout: '', stderr: 'missing command', status: 1 };
        },
      },
    });
    const converter = new PdfMarkerConverter();
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '%PDF test fixture\n', 'utf8');

    const result = await converter.convert(input, {
      runtime,
      runtimeRoot,
      fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });

    expect(result).toEqual({ title: 'PDF Import', markdown: 'Marker body' });
    expect(readFile).toHaveBeenCalledWith(
      join(runtimeRoot, 'source-import-pdf', 'marker-fixed-source-import-id', 'output.md'),
      'utf-8',
    );
  });

  it('resolves PDF converter commands with the injected home and env snapshot', async () => {
    const observedPaths: string[] = [];
    const converter = new PdfMarkerConverter();
    const runtime = fakeRuntime({
      process: {
        exec: async (_command, _args, options) => {
          observedPaths.push(options?.env?.PATH ?? '');
          return { stdout: '/isolated-home/.local/bin/marker_single\n', stderr: '', status: 0 };
        },
      },
    });

    await expect(
      converter.isAvailable({
        runtime,
        runtimeRoot: '/isolated-runtime',
        fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
      }),
    ).resolves.toBe(true);

    expect(observedPaths).toEqual(['/isolated-home/.local/bin:/usr/bin']);
  });
});
