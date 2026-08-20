import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

import {
  ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV,
  ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT,
  PdfMarkerConverter,
  SOURCE_IMPORT_CONVERSION_TIMEOUT_BASE_MS,
  SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS,
  SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS_ENV,
  SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS,
  SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS_ENV,
  SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB,
  SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB_ENV,
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
  cleanupSourceImportRuntimeArtifacts,
  deriveSourceImportReadPolicy,
  prepareSourceImport,
  resolveAdminSourceImportCap,
  resolveSourceImportFile,
  sourceImportConversionTimeoutMs,
  sourceImportConversionWorkerMaxOldMb,
  sourceImportAdminLimitExceededHint,
  type SourceImportReadPolicy,
  type SourceImportRuntime,
} from '#src/kb/ops/source/import.js';
import { convertSourceInWorker } from '#src/kb/ops/source/conversion-worker.js';
import { kbSourceImportSchema } from '#src/kb/tool-contracts.js';
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

  it('derives source import read policies and admin caps from principal binding and env', () => {
    expect(resolveAdminSourceImportCap(envWith())).toBe(ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT);
    expect(resolveAdminSourceImportCap(envWith('4096'))).toBe(4096);
    expect(resolveAdminSourceImportCap(envWith('0'))).toBeNull();
    expect(resolveAdminSourceImportCap(envWith('unlimited'))).toBeNull();
    expect(resolveAdminSourceImportCap(envWith('abc'))).toBe(ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT);
    expect(ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT).toBe(USER_SOURCE_IMPORT_MAX_BYTES);
    expect(SOURCE_IMPORT_MARKDOWN_OUTPUT_MAX_BYTES).toBe(USER_SOURCE_IMPORT_MAX_BYTES);

    expect(deriveSourceImportReadPolicy(projectBinding('/project'), '/project', envWith('4096'))).toEqual({
      kind: 'sandboxed',
      root: '/project',
      maxBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });
    expect(deriveSourceImportReadPolicy(unboundBinding(), '/project', envWith('4096'))).toEqual({
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
    const policy = deriveSourceImportReadPolicy(projectBinding(root), root, envWith());
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

  it('cleans orphaned source import runtime artifacts on boot recovery', () => {
    const root = tempRoot('coral-source-import-cleanup-');
    const runtimeRoot = join(root, 'runtime');
    const runtime = fakeRuntime();
    const stagedDir = join(runtimeRoot, 'source-import-staging');
    const pdfDir = join(runtimeRoot, 'source-import-pdf');
    mkdirSync(stagedDir, { recursive: true });
    mkdirSync(pdfDir, { recursive: true });
    writeFileSync(join(stagedDir, 'orphan.md'), '# Orphan\n', 'utf8');
    writeFileSync(join(pdfDir, 'marker-output.md'), '# Temp\n', 'utf8');

    cleanupSourceImportRuntimeArtifacts(runtimeRoot, runtime);

    expect(existsSync(stagedDir)).toBe(false);
    expect(existsSync(pdfDir)).toBe(false);
  });

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

  it('allows an admin unrestricted policy to resolve an out-of-tree absolute path', () => {
    const storage = coherentSizeStorage(1);
    const policy = deriveSourceImportReadPolicy(unboundBinding(), '/project', envWith());

    expect(resolveSourceImportFile('/outside/source.md', policy, storage)).toEqual({ path: '/outside/source.md' });
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

  it('skips byte comparison for admin-unlimited imports but still rejects non-files', () => {
    const policy = deriveSourceImportReadPolicy(unboundBinding(), '/project', envWith('0'));

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
    const policy = deriveSourceImportReadPolicy(projectBinding(projectRoot), projectRoot, envWith());
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

  it('stages HTML imports through async storage reads', async () => {
    const root = tempRoot('coral-source-import-html-');
    const input = join(root, 'paper.html');
    const runtimeRoot = join(root, 'runtime');
    const { storage, readFile } = storageWithReadSpy();
    const runtime = fakeRuntime({ storage });
    const policy = deriveSourceImportReadPolicy(projectBinding(root), root, envWith());
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

  it('scales source conversion worker timeouts by input size with env overrides', () => {
    expect(sourceImportConversionTimeoutMs({}, 1)).toBe(
      SOURCE_IMPORT_CONVERSION_TIMEOUT_BASE_MS + SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS,
    );
    expect(sourceImportConversionTimeoutMs({}, 5 * 1024 * 1024)).toBe(
      SOURCE_IMPORT_CONVERSION_TIMEOUT_BASE_MS + 5 * SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS,
    );
    expect(sourceImportConversionTimeoutMs({}, 1024 * 1024 * 1024)).toBe(SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS);
    expect(
      sourceImportConversionTimeoutMs(
        {
          [SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS_ENV]: '1000',
          [SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS_ENV]: '130000',
        },
        20 * 1024 * 1024,
      ),
    ).toBe(130000);
  });

  it('configures source conversion worker old-generation memory limits from env', () => {
    expect(sourceImportConversionWorkerMaxOldMb({})).toBe(SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB);
    expect(sourceImportConversionWorkerMaxOldMb({ [SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB_ENV]: '768' })).toBe(768);
    expect(sourceImportConversionWorkerMaxOldMb({ [SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB_ENV]: '0' })).toBe(
      SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB,
    );
  });

  it('rejects HTML converter worker output above the markdown byte cap', async () => {
    const root = tempRoot('coral-source-import-html-worker-cap-');
    const input = join(root, 'paper.html');
    const runtimeRoot = join(root, 'runtime');
    const runtime = fakeRuntime();
    const policy = deriveSourceImportReadPolicy(unboundBinding(), root, envWith('0'));
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(
      input,
      '<html><head><title>HTML Import</title></head><body><h1>HTML Import</h1><p>Body body body body body body body body body body</p></body></html>',
      'utf8',
    );
    const sourceFile = resolveSourceImportFile(input, policy, runtime.storage);

    await expect(
      prepareSourceImport(sourceFile, undefined, policy.maxBytes, () => {}, runtimeRoot, runtime, {
        maxMarkdownOutputBytes: 16,
        limitExceededHint: sourceImportAdminLimitExceededHint(),
      }),
    ).rejects.toThrow(
      new RegExp(`HTML converter output exceeds maximum markdown output size.*${ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV}`),
    );
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
            // The shape `runtime/exec-builder.ts` actually produces for its own timeout: a message *and* the
            // `ETIMEDOUT` code. The code is what tells a timeout from a child killed from outside, and this
            // fixture carried only the message — so it agreed with a reader that matched on the message and
            // would have gone on agreeing with one that got the distinction wrong.
            return {
              stdout: '',
              stderr: '',
              status: null,
              error: Object.assign(new Error('timeout: /usr/bin/marker_single'), { code: 'ETIMEDOUT' }),
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
    ).resolves.toEqual({ kind: 'available' });

    expect(observedPaths).toEqual(['/isolated-home/.local/bin:/usr/bin']);
  });
});

// `which` has three outcomes and the converter used to see two. A probe that never ran arrived as "the tool is
// not installed", and the negative answer here does not merely produce advice — it runs `install()`, which
// downloads and writes uv and marker-pdf. That is a finalization authorized by evidence nobody produced, on a
// machine that quite possibly already has both.
describe('PdfMarkerConverter separates "not installed" from "could not check"', () => {
  const ctx = (runtime: SourceImportRuntime) => ({
    runtime,
    runtimeRoot: '/isolated-runtime',
    fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
  });

  /** The port resolves for a child that never answered; it does not reject. */
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

  it.each([['ETIMEDOUT'], ['EAGAIN']])('reports %s as undetermined, not as absent', async (code) => {
    // The reason travels with the answer: it is the only thing separating "retry" from "this machine cannot
    // run the lookup", and the caller renders one of those two sentences from it.
    await expect(new PdfMarkerConverter().isAvailable(ctx(locatorUnanswered(code)))).resolves.toEqual({
      kind: 'undetermined',
      detail: code,
    });
  });

  // `which` itself missing is not a fact about marker_single, so it is still undetermined — but it is a
  // standing one, and the advice must not be the retry that cannot work.
  it('does not tell an operator to retry when the lookup itself cannot be launched', async () => {
    await expect(new PdfMarkerConverter().isAvailable(ctx(locatorUnanswered('ENOENT')))).resolves.toEqual({
      kind: 'undetermined',
      detail: 'ENOENT',
    });
    await expect(new PdfMarkerConverter().install(() => {}, ctx(locatorUnanswered('ENOENT')))).rejects.toThrow(
      /A retry will fail the same way/u,
    );
  });

  // Both shapes of a failing locator. GNU `which` exits 1 with nothing on stdout — measured, by spawning it —
  // but BusyBox and several shell builtins print `<name> not found` *to stdout* and still exit non-zero. Read
  // by output rather than by exit code, that line becomes the path Coral then tries to execute.
  it.each([
    ['silent, as GNU which is', ''],
    ['printing its complaint to stdout, as BusyBox does', 'marker_single not found\n'],
  ])('reports a locator that ran and found nothing as absent when %s', async (_label, stdout) => {
    const runtime = fakeRuntime({
      process: { exec: async () => ({ stdout, stderr: 'not found', status: 1 }) },
    });

    await expect(new PdfMarkerConverter().isAvailable(ctx(runtime))).resolves.toEqual({ kind: 'absent' });
  });

  it('does not install anything when it could not check for uv', async () => {
    const commands: string[] = [];
    const runtime = fakeRuntime({
      process: {
        exec: async (command) => {
          commands.push(command);
          return {
            stdout: '',
            stderr: '',
            status: null,
            error: Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }),
          };
        },
      },
    });

    await expect(new PdfMarkerConverter().install(() => {}, ctx(runtime))).rejects.toThrow(
      /Could not check whether uv is installed \(EAGAIN\)/,
    );
    expect(commands, 'only the locator ran; no installer was launched').toEqual(['which']);
  });

  it('refuses to convert without claiming marker_single is missing', async () => {
    const root = tempRoot('coral-source-import-undetermined-');
    const input = join(root, 'paper.pdf');
    mkdirSync(root, { recursive: true });
    writeFileSync(input, '%PDF test fixture\n', 'utf8');

    await expect(
      new PdfMarkerConverter().convert(input, {
        runtime: locatorUnanswered('ETIMEDOUT'),
        runtimeRoot: join(root, 'runtime'),
        fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
      }),
    ).rejects.toThrow('this is not a report that it is missing');
  });
});

// `runCommand`'s three non-answers each get a different exit, and only one of them is a retry. The overflow
// case had no test: a child whose output exceeds `maxBuffer` is killed, so the command did not answer — and
// running it again on the same source overflows again, which makes "Retry the import" the one instruction
// that cannot work.
describe('a converter command that overran its buffer is not told to retry', () => {
  it('names the source size as the thing to change', async () => {
    const root = tempRoot('coral-source-import-maxbuffer-');
    const input = join(root, 'paper.pdf');
    mkdirSync(root, { recursive: true });
    writeFileSync(input, '%PDF test fixture\n', 'utf8');

    const runtime = fakeRuntime({
      process: {
        exec: async (command) =>
          command === 'which'
            ? { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 }
            : {
                stdout: '',
                stderr: '',
                status: null,
                // The shape `runtime/exec-builder.ts` produces when it kills a child for overflow.
                error: Object.assign(new Error('maxBuffer exceeded: marker_single'), {
                  code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                }),
              },
      },
    });

    const failure = await new PdfMarkerConverter()
      .convert(input, { runtime, runtimeRoot: join(root, 'runtime'), fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES })
      .then(
        () => null,
        (error: unknown) => (error as Error).message,
      );

    expect(failure, 'the command did not answer, so this is not a report that it failed').toMatch(
      /could not be run \(ERR_CHILD_PROCESS_STDIO_MAXBUFFER\)/u,
    );
    expect(failure, 'and the exit is a smaller source, not another identical attempt').toMatch(
      /import a smaller source/u,
    );
    expect(failure).not.toMatch(/Retry the import/u);
  });
});

// `runCommand`'s `launch-refused` arm was exercised only through the `which` locator's own launch failure
// (`resolveCommandPath`'s "could not be launched at all" case above) — never for the command `which` had just
// resolved. That gap is reachable: a binary can be removed, or lose its execute bit, between `which` finding
// it and this module spawning it.
describe('a converter command that cannot be launched, after `which` found it', () => {
  it('reports the launch failure rather than a claim that the command ran and failed', async () => {
    const root = tempRoot('coral-source-import-launch-refused-');
    const input = join(root, 'paper.pdf');
    mkdirSync(root, { recursive: true });
    writeFileSync(input, '%PDF test fixture\n', 'utf8');

    const runtime = fakeRuntime({
      process: {
        exec: async (command) =>
          command === 'which'
            ? { stdout: '/usr/bin/marker_single\n', stderr: '', status: 0 }
            : {
                stdout: '',
                stderr: '',
                status: null,
                // The shape `runtime/exec-builder.ts` produces when `spawn`'s own `error` event fires — the
                // resolved path was removed or lost its execute bit between the lookup and this spawn.
                error: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
              },
      },
    });

    const failure = await new PdfMarkerConverter()
      .convert(input, { runtime, runtimeRoot: join(root, 'runtime'), fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES })
      .then(
        () => null,
        (error: unknown) => (error as Error).message,
      );

    expect(failure, 'the child never ran, so this is not a report that it failed').toMatch(
      /could not be run \(EACCES\)/u,
    );
    expect(failure, 'a standing errno is a launch failure, not a transient one, so the exit is not a retry').toMatch(
      /could not be launched at all/u,
    );
  });
});

// `install()` and `convert()` decide between "not there" and "could not tell" at more points, and only
// the `undetermined` ones were pinned. The `absent` branches are what make the failure legible — "uv was not
// found on PATH after its installer ran" is a different problem from a machine that cannot answer — and
// disabling any of them left the suite green.
describe('the marker install and convert paths report which of the two they observed', () => {
  const ctx = (runtime: SourceImportRuntime, root: string) => ({
    runtime,
    runtimeRoot: join(root, 'runtime'),
    fileSizeLimitBytes: USER_SOURCE_IMPORT_MAX_BYTES,
  });

  /** `which <name>` answers per the map; every other command succeeds, so only the lookups decide. */
  function locator(answers: Record<string, { stdout: string; status: number }>): SourceImportRuntime {
    return fakeRuntime({
      process: {
        exec: async (command, args) =>
          command === 'which'
            ? { stderr: '', ...(answers[args[0]] ?? { stdout: '', status: 1 }) }
            : { stdout: '', stderr: '', status: 0 },
      },
    });
  }

  it('installs uv when the lookup says it is absent, and names PATH as the likely cause if it is still absent afterwards', async () => {
    const root = tempRoot('coral-source-import-uv-absent-');
    const runtime = locator({});
    const logged: string[] = [];

    const failure = await new PdfMarkerConverter()
      .install((m) => logged.push(m), ctx(runtime, root))
      .then(
        () => null,
        (error: unknown) => (error as Error).message,
      );

    expect(failure).toMatch(/uv was not found on PATH after its installer ran/u);
    expect(failure, 'a dead-end refusal names no action; this one does').toMatch(/add that directory to PATH/u);
    expect(logged, 'an absent tool is installed; an unknown one is not').toContain('Installing uv...');
  });

  it('says marker_single is missing after its own install, and names PATH as the likely cause', async () => {
    const root = tempRoot('coral-source-import-marker-absent-');
    const runtime = locator({ uv: { stdout: '/usr/bin/uv\n', status: 0 } });

    const failure = await new PdfMarkerConverter()
      .install(() => {}, ctx(runtime, root))
      .then(
        () => null,
        (error: unknown) => (error as Error).message,
      );

    expect(failure).toMatch(/marker_single was not found on PATH after installing marker-pdf/u);
    expect(failure, 'a dead-end refusal names no action; this one does').toMatch(/uv tool update-shell/u);
  });

  // The second lookup, after the install ran. It is a different question from the first — the tool was just
  // written to disk, so "absent" and "could not check" mean different things about whether the install worked
  // — and both messages were unasserted.
  it.each([
    ['uv', /uv was installed, but checking for it did not answer \(ETIMEDOUT\)/u],
    ['marker_single', /marker-pdf was installed, but checking for marker_single did not answer \(ETIMEDOUT\)/u],
  ])('separates absent from unanswerable when re-checking %s after installing', async (tool, expected) => {
    const root = tempRoot(`coral-source-import-recheck-${tool}-`);
    const timedOut = {
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    };
    const absent = { stdout: '', stderr: 'not found', status: 1 };
    const found = (path: string) => ({ stdout: `${path}\n`, stderr: '', status: 0 });
    // `uv` is looked up twice — absent, install, then re-check — so its re-check is the second call. There is
    // only one `marker_single` lookup in `install()`, and it is already the post-install one.
    let uvLookups = 0;
    const runtime = fakeRuntime({
      process: {
        exec: async (command, args) => {
          if (command !== 'which') return { stdout: '', stderr: '', status: 0 };
          if (args[0] === 'uv') {
            uvLookups += 1;
            if (tool === 'marker_single') return found('/usr/bin/uv');
            return uvLookups === 1 ? absent : timedOut;
          }
          return timedOut;
        },
      },
    });

    const failure = await new PdfMarkerConverter()
      .install(() => {}, ctx(runtime, root))
      .then(
        () => null,
        (error: unknown) => (error as Error).message,
      );

    expect(failure).toMatch(expected);
    // ETIMEDOUT is neither a standing errno nor the maxBuffer code, so `nonAnswerExit` falls to its default —
    // the one branch this suite otherwise only ever asserted the *absence* of, on the overflow case above.
    expect(failure, 'ETIMEDOUT is transient, so the exit nonAnswerExit names for it is a retry').toMatch(
      /Retry the import\.$/u,
    );
  });

  it('refuses to convert when the lookup answers that marker_single is absent, naming the race rather than stopping cold', async () => {
    const root = tempRoot('coral-source-import-convert-absent-');
    const input = join(root, 'paper.pdf');
    mkdirSync(root, { recursive: true });
    writeFileSync(input, '%PDF test fixture\n', 'utf8');

    const failure = await new PdfMarkerConverter().convert(input, ctx(locator({}), root)).then(
      () => null,
      (error: unknown) => (error as Error).message,
    );

    expect(failure).toMatch(/marker_single is not available/u);
    expect(failure, 'this is a TOCTOU race with an earlier check, not a fresh report of absence').toMatch(
      /found moments ago/u,
    );
    expect(failure, 'a dead-end refusal names no action; this one does').toMatch(/Retry the import/u);
  });
});

// The trigger itself: an absent converter must reach `install()`, and an undetermined one must not. Disabling
// the `absent` branch skipped the install silently and failed later inside `convert()`, which reports a
// different problem than the one that occurred.
describe('prepareSourceImport installs only for an observed absence', () => {
  it('runs install when the converter is absent, rather than falling through to convert', async () => {
    const root = tempRoot('coral-source-import-trigger-');
    const runtimeRoot = join(root, 'runtime');
    const input = join(root, 'paper.pdf');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '%PDF fixture\n', 'utf8');
    const runtime = fakeRuntime({
      // Every lookup says "not on this PATH", so `install()` runs and fails at its own first re-check. That
      // message is what distinguishes having tried from having skipped.
      process: { exec: async (command) => ({ stdout: '', stderr: '', status: command === 'which' ? 1 : 0 }) },
    });
    const policy = deriveSourceImportReadPolicy(projectBinding(root), root, envWith());
    const sourceFile = resolveSourceImportFile(input, policy, runtime.storage);

    await expect(
      prepareSourceImport(sourceFile, undefined, policy.maxBytes, () => {}, runtimeRoot, runtime, {}),
    ).rejects.toThrow('uv was not found on PATH after its installer ran');
  });
});
