import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ensureKiwiArtifact, inspectKiwiArtifact } from '#src/engines/kiwi/artifact.js';
import { KIWI_MODEL_FILES, type KiwiModelFileName } from '#src/engines/kiwi/constants.js';
import { writeKiwiModelFilesAtomicInWorker } from '#src/engines/kiwi/model-artifact.js';
import { publishKiwiWasmArtifact } from '#src/engines/kiwi/wasm-artifact.js';
import { createRealRuntime } from '#src/runtime/real.js';

const wasmFixture = readFileSync(join(process.cwd(), 'node_modules', 'kiwi-nlp', 'dist', 'kiwi-wasm.wasm'));

function createTestRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'coral-kiwi-artifact-'));
  return {
    root,
    runtime: createRealRuntime('prod', { baseDir: root }),
  };
}

function modelFiles(): ReadonlyMap<KiwiModelFileName, Buffer> {
  return new Map(KIWI_MODEL_FILES.map((name) => [name, Buffer.from(`model:${name}`)]));
}

describe('Kiwi composite artifact', () => {
  it('installs both missing components in model-then-WASM order', async () => {
    const { root, runtime } = createTestRuntime();
    const events: string[] = [];
    try {
      const ensureModelArtifact = vi.fn(async () => {
        events.push('model');
        await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
        return {
          status: 'installed' as const,
          method: 'github-release' as const,
          version: '0.23.0',
          targetDir: root,
        };
      });
      const ensureWasmArtifact = vi.fn(async () => {
        expect(inspectKiwiArtifact(runtime).model.installed).toBe(true);
        events.push('wasm');
        return publishKiwiWasmArtifact(runtime, wasmFixture);
      });

      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact,
        ensureWasmArtifact,
      });

      expect(result).toMatchObject({ status: 'installed', method: 'runtime-download' });
      expect(events).toEqual(['model', 'wasm']);
      expect(inspectKiwiArtifact(runtime).ready).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a successfully installed model when WASM installation fails', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      const ensureModelArtifact = vi.fn(async () => {
        await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
        return {
          status: 'installed' as const,
          method: 'github-release' as const,
          version: '0.23.0',
          targetDir: root,
        };
      });

      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact,
        ensureWasmArtifact: async () => {
          throw new Error('WASM download failed');
        },
      });

      expect(result).toMatchObject({
        status: 'error',
        code: 'expansion_install_artifact_failed',
        remediation: expect.stringContaining('coral-cli expansion equip kiwi'),
        context: { name: 'kiwi', detail: 'WASM download failed' },
      });
      expect(inspectKiwiArtifact(runtime)).toMatchObject({
        ready: false,
        missingComponents: ['wasm'],
        model: { installed: true },
        wasm: { installed: false },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent public ensures so component installation runs once', async () => {
    const { root, runtime } = createTestRuntime();
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const ensureModelArtifact = vi.fn(async () => {
      await modelGate;
      await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
      return {
        status: 'installed' as const,
        method: 'github-release' as const,
        version: '0.23.0',
        targetDir: root,
      };
    });
    const ensureWasmArtifact = vi.fn(async () => publishKiwiWasmArtifact(runtime, wasmFixture));

    try {
      const first = ensureKiwiArtifact(runtime, { ensureModelArtifact, ensureWasmArtifact });
      await vi.waitFor(() => expect(ensureModelArtifact).toHaveBeenCalledTimes(1));
      const second = ensureKiwiArtifact(runtime, {
        ensureModelArtifact,
        ensureWasmArtifact,
        lockTimeoutMs: 5_000,
      });

      releaseModel();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ status: 'installed' }),
        expect.objectContaining({ status: 'already_installed' }),
      ]);
      expect(ensureModelArtifact).toHaveBeenCalledTimes(1);
      expect(ensureWasmArtifact).toHaveBeenCalledTimes(1);
    } finally {
      releaseModel();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `runtime/download.ts` rethrows a `fetch` rejection unchanged, and `fetch` puts the errno on `.cause` while
  // its own message is the constant `'fetch failed'`. So the code is the only part of this that names what went
  // wrong, and reading `.code` off the top level dropped exactly that — an unreachable host arrived as a
  // detail of `'fetch failed'` with no `causeCode` at all.
  it('keeps the errno a fetch rejection hides on its cause', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact: async () => {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' }),
          });
        },
      });

      expect(result).toMatchObject({
        status: 'error',
        code: 'expansion_install_artifact_failed',
        context: { name: 'kiwi', detail: 'fetch failed', causeName: 'TypeError', causeCode: 'ENOTFOUND' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
