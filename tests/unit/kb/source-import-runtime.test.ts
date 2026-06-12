import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SOURCE_IMPORT_FILE_BYTES,
  PdfMarkerConverter,
  prepareSourceImport,
  resolveSourceImportFilePath,
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('source import runtime isolation', () => {
  it('rejects traversal source paths at the tool-contract boundary', () => {
    expect(kbSourceImportSchema.safeParse({ filePath: '../outside.md' }).success).toBe(false);
  });

  it('uses injected ids and time when staging markdown imports', async () => {
    const root = tempRoot('coral-source-import-runtime-');
    const input = join(root, 'paper.md');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# Runtime Isolated\n\nBody\n', 'utf8');

    const prepared = await prepareSourceImport(input, undefined, () => {}, runtimeRoot, fakeRuntime(), {
      allowedReadRoot: root,
    });

    expect(prepared.stagedPath).toBe(join(runtimeRoot, 'source-import-staging', 'fixed-source-import-id.md'));
    expect(readFileSync(prepared.stagedPath, 'utf8')).toContain('importedAt: 2026-04-24T00:00:00.000Z');
  });

  it('rejects traversal source paths before reading', async () => {
    const root = tempRoot('coral-source-import-traversal-');
    const projectRoot = join(root, 'project');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });

    await expect(
      prepareSourceImport('../outside.md', undefined, () => {}, runtimeRoot, fakeRuntime(), {
        allowedReadRoot: projectRoot,
      }),
    ).rejects.toThrow(/must not contain "\.\."/);
  });

  it('rejects source paths that escape the allowed project root', () => {
    const root = tempRoot('coral-source-import-escape-');
    const projectRoot = join(root, 'project');
    const outside = join(root, 'outside.md');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(outside, '# Outside\n\nSecret\n', 'utf8');

    expect(() => resolveSourceImportFilePath(outside, projectRoot, fakeRuntime().storage)).toThrow(/must stay within/);
  });

  it('rejects oversized source files before reading', async () => {
    const root = tempRoot('coral-source-import-oversize-');
    const projectRoot = join(root, 'project');
    const runtimeRoot = join(root, 'runtime');
    const input = join(projectRoot, 'large.md');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# Large\n\nBody exceeds a tiny test cap.\n', 'utf8');

    await expect(
      prepareSourceImport(input, undefined, () => {}, runtimeRoot, fakeRuntime(), {
        allowedReadRoot: projectRoot,
        fileSizeLimitBytes: 8,
      }),
    ).rejects.toThrow(/exceeds maximum source import size/);
  });

  it('accepts an absolute source path inside the allowed project root', async () => {
    const root = tempRoot('coral-source-import-in-scope-');
    const projectRoot = join(root, 'project');
    const runtimeRoot = join(root, 'runtime');
    const input = join(projectRoot, 'paper.md');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# In Scope\n\nBody\n', 'utf8');

    const prepared = await prepareSourceImport(input, undefined, () => {}, runtimeRoot, fakeRuntime(), {
      allowedReadRoot: projectRoot,
    });

    expect(readFileSync(prepared.stagedPath, 'utf8')).toContain('# In Scope\n\nBody');
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
        fileSizeLimitBytes: MAX_SOURCE_IMPORT_FILE_BYTES,
      }),
    ).resolves.toBe(true);

    expect(observedPaths).toEqual(['/isolated-home/.local/bin:/usr/bin']);
  });
});
