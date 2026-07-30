import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadKiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import { kiwiWasmPath } from '#src/engines/kiwi/paths.js';
import { createKiwiApi, type KiwiWasmInitializer } from '#src/engines/kiwi/wasm-loader.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';

function createRuntime(): Pick<Runtime, 'paths'> {
  return {
    paths: {
      coral: {
        engine: {
          dataDir: (name: string) => `/runtime/engines/${name}`,
        },
      },
    },
  } as Pick<Runtime, 'paths'>;
}

describe('Kiwi WASM loader wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves only kiwi-wasm.wasm from the installed runtime artifact', async () => {
    const runtime = createRuntime();
    let locateFile: ((path: string, prefix?: string) => string) | undefined;
    const initialize: KiwiWasmInitializer = async (moduleArg) => {
      locateFile = (moduleArg as { locateFile: (path: string, prefix?: string) => string }).locateFile;
      return {
        FS: {
          mkdir: () => {},
          writeFile: () => {},
          unlink: () => {},
          rmdir: () => {},
        },
        api: () => '{}',
      };
    };

    await createKiwiApi(runtime, initialize);

    expect(locateFile).toBeDefined();
    expect(locateFile!('kiwi-wasm.wasm', '/bundle/')).toBe(kiwiWasmPath(runtime));
    expect(locateFile!('worker.js', '/bundle/')).toBe('/bundle/worker.js');
    expect(locateFile!('nested/kiwi-wasm.wasm', '/bundle/')).toBe('/bundle/nested/kiwi-wasm.wasm');
  });

  it('instantiates the real pinned Emscripten initializer from the runtime WASM path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kiwi-loader-'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const runtimeWasmPath = kiwiWasmPath(runtime);
    try {
      mkdirSync(dirname(runtimeWasmPath), { recursive: true });
      copyFileSync(join(process.cwd(), 'node_modules', 'kiwi-nlp', 'dist', 'kiwi-wasm.wasm'), runtimeWasmPath);

      const api = await createKiwiApi(runtime);

      expect(api.cmd).toBeTypeOf('function');
      expect(api.loadModelFiles).toBeTypeOf('function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
