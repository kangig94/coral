import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV,
  ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT,
  PdfMarkerConverter,
  SOURCE_IMPORT_MARKER_CPU_TIMEOUT_BASE_MS,
  SOURCE_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS_ENV,
  SOURCE_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS,
  SOURCE_IMPORT_MARKER_DEVICE_ENV,
  SOURCE_IMPORT_MARKER_GPU_DETECT_TIMEOUT_MS,
  SOURCE_IMPORT_MARKER_GPU_TIMEOUT_BASE_MS,
  SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS,
  SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS,
  SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS_ENV,
  SOURCE_IMPORT_MARKDOWN_OUTPUT_MAX_BYTES,
  USER_SOURCE_IMPORT_MAX_BYTES,
  deriveSourceImportReadPolicy,
  prepareSourceImport,
  resolveAdminSourceImportCap,
  resolveSourceImportFile,
  sourceImportAdminLimitExceededHint,
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

function runtimeEnv(snapshot: Record<string, string>, platform = 'linux'): SourceImportRuntime['env'] {
  return {
    fullSnapshot: () => snapshot,
    homedir: () => '/isolated-home',
    platform: () => platform,
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
    expect(ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT).toBe(USER_SOURCE_IMPORT_MAX_BYTES);
    expect(SOURCE_IMPORT_MARKDOWN_OUTPUT_MAX_BYTES).toBe(USER_SOURCE_IMPORT_MAX_BYTES);

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
    ).toThrow(new RegExp(`exceeds maximum source import size.*${ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV}=<bytes>`));
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

  it('rejects converted markdown output above the import byte cap with an admin override hint', async () => {
    const root = tempRoot('coral-source-import-output-cap-');
    const input = join(root, 'paper.md');
    const runtimeRoot = join(root, 'runtime');
    const runtime = fakeRuntime();
    const policy = deriveSourceImportReadPolicy('admin', root, envWith('16'));
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# A\n', 'utf8');
    const sourceFile = resolveSourceImportFile(input, policy, runtime.storage);

    await expect(
      prepareSourceImport(sourceFile, undefined, policy.maxBytes, () => {}, runtimeRoot, runtime, {
        limitExceededHint: sourceImportAdminLimitExceededHint(),
      }),
    ).rejects.toThrow(new RegExp(`markdown output exceeds maximum size.*${ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV}=<bytes>`));
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

  it('parses marker output through async storage reads with a CPU-conservative timeout by default', async () => {
    const root = tempRoot('coral-source-import-marker-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const { storage, readFile } = storageWithReadSpy();
    const markerExecArgs: string[][] = [];
    const markerExecOptions: Array<{ timeout?: number; maxBuffer?: number }> = [];
    const runtime = fakeRuntime({
      storage,
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/marker_single') {
            markerExecArgs.push(args);
            markerExecOptions.push(options ?? {});
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
    expect(markerExecArgs).toEqual([[input, '--output_dir', expect.any(String), '--disable_tqdm']]);
    expect(markerExecOptions).toEqual([
      expect.objectContaining({
        maxBuffer: 20 * 1024 * 1024,
        timeout: SOURCE_IMPORT_MARKER_CPU_TIMEOUT_BASE_MS + SOURCE_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS,
      }),
    ]);
    expect(readFile).toHaveBeenCalledWith(
      join(runtimeRoot, 'source-import-pdf', 'marker-fixed-source-import-id', 'output.md'),
      'utf-8',
    );
  });

  it('explains the marker timeout override when PDF conversion times out', async () => {
    const root = tempRoot('coral-source-import-marker-timeout-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const markerExecOptions: Array<{ timeout?: number }> = [];
    const runtime = fakeRuntime({
      env: runtimeEnv({ PATH: '/usr/bin', [SOURCE_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS_ENV]: '1234' }),
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/marker_single') {
            markerExecOptions.push(options ?? {});
            return {
              stdout: '',
              stderr: '',
              status: null,
              error: new Error('timeout: /usr/bin/marker_single'),
            };
          }
          return { stdout: '', stderr: 'missing command', status: 1 };
        },
      },
    });
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '%PDF test fixture\n', 'utf8');

    await expect(
      new PdfMarkerConverter().convert(input, {
        runtime,
        runtimeRoot,
        fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
      }),
    ).rejects.toThrow(
      'marker_single timed out after 2s. For large or scanned PDFs, retry as an async import, split the file, or increase CORAL_KB_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS. Set CORAL_KB_IMPORT_MARKER_DEVICE=cuda or CORAL_KB_IMPORT_MARKER_DEVICE=mps before starting the Coral daemon to force GPU conversion when enough VRAM is available.',
    );

    expect(markerExecOptions).toEqual([expect.objectContaining({ timeout: 1234 })]);
  });

  it('auto-selects CUDA when nvidia-smi reports a GPU', async () => {
    const root = tempRoot('coral-source-import-marker-auto-gpu-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const detectExecOptions: Array<{ timeout?: number }> = [];
    const markerExecOptions: Array<{ timeout?: number; env?: Record<string, string> }> = [];
    const runtime = fakeRuntime({
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === 'nvidia-smi') {
            detectExecOptions.push(options ?? {});
            return { stdout: '0\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/marker_single') {
            markerExecOptions.push(options ?? {});
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
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, Buffer.alloc(2 * 1024 * 1024));

    await new PdfMarkerConverter().convert(input, {
      runtime,
      runtimeRoot,
      fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });

    expect(detectExecOptions).toEqual([
      expect.objectContaining({ timeout: SOURCE_IMPORT_MARKER_GPU_DETECT_TIMEOUT_MS }),
    ]);
    expect(markerExecOptions).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({
          TORCH_DEVICE: 'cuda',
          CUDA_VISIBLE_DEVICES: '0',
          PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
        }),
        timeout: SOURCE_IMPORT_MARKER_GPU_TIMEOUT_BASE_MS + 2 * SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS,
      }),
    ]);
  });

  it('auto-selects MPS on Apple Silicon when CUDA is unavailable', async () => {
    const root = tempRoot('coral-source-import-marker-auto-mps-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const detectCommands: string[] = [];
    const markerExecOptions: Array<{ timeout?: number; env?: Record<string, string> }> = [];
    const runtime = fakeRuntime({
      env: runtimeEnv({ PATH: '/usr/bin' }, 'darwin'),
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === 'nvidia-smi') {
            detectCommands.push(command);
            return { stdout: '', stderr: 'not found', status: 1 };
          }
          if (command === 'sysctl' && args.join(' ') === '-n hw.optional.arm64') {
            detectCommands.push(command);
            expect(options).toEqual(expect.objectContaining({ timeout: SOURCE_IMPORT_MARKER_GPU_DETECT_TIMEOUT_MS }));
            return { stdout: '1\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/marker_single') {
            markerExecOptions.push(options ?? {});
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
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, Buffer.alloc(2 * 1024 * 1024));

    await new PdfMarkerConverter().convert(input, {
      runtime,
      runtimeRoot,
      fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });

    expect(detectCommands).toEqual(['nvidia-smi', 'sysctl']);
    expect(markerExecOptions).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({
          TORCH_DEVICE: 'mps',
        }),
        timeout: SOURCE_IMPORT_MARKER_GPU_TIMEOUT_BASE_MS + 2 * SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS,
      }),
    ]);
    expect(markerExecOptions[0]?.env?.CUDA_VISIBLE_DEVICES).toBeUndefined();
  });

  it('accepts metal as an alias for marker MPS conversion', async () => {
    const root = tempRoot('coral-source-import-marker-metal-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const markerExecOptions: Array<{ timeout?: number; env?: Record<string, string> }> = [];
    const runtime = fakeRuntime({
      env: runtimeEnv({ PATH: '/usr/bin', [SOURCE_IMPORT_MARKER_DEVICE_ENV]: 'metal' }, 'darwin'),
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === 'nvidia-smi' || command === 'sysctl') {
            throw new Error('explicit metal should not probe device availability');
          }
          if (command === '/usr/bin/marker_single') {
            markerExecOptions.push(options ?? {});
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
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, Buffer.alloc(2 * 1024 * 1024));

    await new PdfMarkerConverter().convert(input, {
      runtime,
      runtimeRoot,
      fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });

    expect(markerExecOptions).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({
          TORCH_DEVICE: 'mps',
        }),
        timeout: SOURCE_IMPORT_MARKER_GPU_TIMEOUT_BASE_MS + 2 * SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS,
      }),
    ]);
  });

  it('forces marker CPU conversion when requested by environment', async () => {
    const root = tempRoot('coral-source-import-marker-cpu-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const markerExecOptions: Array<{ timeout?: number; env?: Record<string, string> }> = [];
    const runtime = fakeRuntime({
      env: runtimeEnv({ PATH: '/usr/bin', [SOURCE_IMPORT_MARKER_DEVICE_ENV]: 'cpu', CUDA_VISIBLE_DEVICES: '0' }),
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/marker_single') {
            markerExecOptions.push(options ?? {});
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
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '%PDF test fixture\n', 'utf8');

    await new PdfMarkerConverter().convert(input, {
      runtime,
      runtimeRoot,
      fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });

    expect(markerExecOptions).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({
          TORCH_DEVICE: 'cpu',
          CUDA_VISIBLE_DEVICES: '',
        }),
        timeout: SOURCE_IMPORT_MARKER_CPU_TIMEOUT_BASE_MS + SOURCE_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS,
      }),
    ]);
  });

  it('uses marker GPU timeout and CUDA env when requested by environment', async () => {
    const root = tempRoot('coral-source-import-marker-gpu-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    const markerExecOptions: Array<{ timeout?: number; env?: Record<string, string> }> = [];
    const runtime = fakeRuntime({
      env: runtimeEnv({
        PATH: '/usr/bin',
        [SOURCE_IMPORT_MARKER_DEVICE_ENV]: 'cuda',
        CUDA_VISIBLE_DEVICES: '2',
      }),
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/marker_single') {
            markerExecOptions.push(options ?? {});
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
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, Buffer.alloc(2 * 1024 * 1024));

    await new PdfMarkerConverter().convert(input, {
      runtime,
      runtimeRoot,
      fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });

    expect(markerExecOptions).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({
          TORCH_DEVICE: 'cuda',
          CUDA_VISIBLE_DEVICES: '2',
          PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
        }),
        timeout: SOURCE_IMPORT_MARKER_GPU_TIMEOUT_BASE_MS + 2 * SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS,
      }),
    ]);
  });

  it('uses a longer marker install timeout for uv tool install', async () => {
    const installExecOptions: Array<{ timeout?: number }> = [];
    const runtime = fakeRuntime({
      env: runtimeEnv({ PATH: '/usr/bin', [SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS_ENV]: '123456' }),
      process: {
        exec: async (command, args, options) => {
          if (command === 'which' && args[0] === 'uv') {
            return { stdout: '/usr/bin/uv\n', stderr: '', status: 0 };
          }
          if (command === '/usr/bin/uv') {
            installExecOptions.push(options ?? {});
            return { stdout: '', stderr: '', status: 0 };
          }
          if (command === 'which' && args[0] === 'marker_single') {
            return { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 };
          }
          return { stdout: '', stderr: 'missing command', status: 1 };
        },
      },
    });

    await new PdfMarkerConverter().install(() => {}, {
      runtime,
      runtimeRoot: '/isolated-runtime',
      fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });

    expect(SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(installExecOptions).toEqual([expect.objectContaining({ timeout: 123456 })]);
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
