import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadKiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import { createRealRuntime } from '#src/runtime/real.js';

describe('Kiwi WASM loader wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every missing composite component through the public analyzer loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kiwi-loader-missing-'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    try {
      await expect(loadKiwiAnalyzer(runtime)).rejects.toThrow(
        /Kiwi runtime artifacts are not installed \(model, wasm missing\).*coral-cli expansion equip kiwi/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces a structured install-path failure through the public analyzer loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kiwi-loader-install-error-'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    vi.spyOn(runtime.storage, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    try {
      const failure = loadKiwiAnalyzer(runtime, { installIfMissing: true });
      await expect(failure).rejects.toThrow(
        /Cannot write to the Coral expansion install path for kiwi.*Check filesystem permissions and free space/s,
      );
      await expect(failure).rejects.toMatchObject({
        cause: {
          status: 'error',
          code: 'expansion_install_path_unwritable',
          context: { name: 'kiwi' },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
