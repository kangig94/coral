import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PdfMarkerConverter,
  prepareSourceImport,
  type SourceImportRuntime,
} from '#src/kb/ops/source-import.js';

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
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('source import runtime isolation', () => {
  it('uses injected ids and time when staging markdown imports', async () => {
    const root = tempRoot('coral-source-import-runtime-');
    const input = join(root, 'paper.md');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(input, '# Runtime Isolated\n\nBody\n', 'utf8');

    const prepared = await prepareSourceImport(input, undefined, () => {}, runtimeRoot, fakeRuntime());

    expect(prepared.stagedPath).toBe(join(runtimeRoot, 'source-import-staging', 'fixed-source-import-id.md'));
    expect(readFileSync(prepared.stagedPath, 'utf8')).toContain('importedAt: 2026-04-24T00:00:00.000Z');
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

    await expect(converter.isAvailable({ runtime, runtimeRoot: '/isolated-runtime' })).resolves.toBe(true);

    expect(observedPaths).toEqual(['/isolated-home/.local/bin:/usr/bin']);
  });
});
