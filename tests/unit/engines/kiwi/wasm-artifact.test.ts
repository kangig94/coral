import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { KIWI_WASM_SIZE_BYTES } from '#src/engines/kiwi/constants.js';
import { kiwiWasmDir, kiwiWasmManifestPath, kiwiWasmPath } from '#src/engines/kiwi/paths.js';
import {
  ensureKiwiWasmArtifactLocked,
  inspectKiwiWasmArtifact,
  publishKiwiWasmArtifact,
} from '#src/engines/kiwi/wasm-artifact.js';
import { createRealRuntime } from '#src/runtime/real.js';

const wasmFixture = readFileSync(join(process.cwd(), 'node_modules', 'kiwi-nlp', 'dist', 'kiwi-wasm.wasm'));

function createTestRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'coral-kiwi-wasm-'));
  return {
    root,
    runtime: createRealRuntime('prod', { baseDir: root }),
  };
}

describe('Kiwi WASM artifact', () => {
  it('given a wrong-digest payload, when publishing, then rejects before writing artifact files', () => {
    const { root, runtime } = createTestRuntime();
    const corrupt = Buffer.from(wasmFixture);
    corrupt[corrupt.length - 1] ^= 0xff;
    try {
      expect(corrupt).toHaveLength(KIWI_WASM_SIZE_BYTES);
      expect(() => publishKiwiWasmArtifact(runtime, corrupt)).toThrow(/WASM digest mismatch/);
      expect(runtime.storage.existsSync(kiwiWasmPath(runtime))).toBe(false);
      expect(runtime.storage.existsSync(kiwiWasmManifestPath(runtime))).toBe(false);
      expect(
        runtime.storage.existsSync(kiwiWasmDir(runtime)) &&
          readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp')),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when durable payload publication fails and leaves no manifest or temp file', () => {
    const { root, runtime } = createTestRuntime();
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
    const writeSpy = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
    try {
      writeSpy.mockImplementation((path, data, options) =>
        path === kiwiWasmPath(runtime) ? false : writeAtomicDurableSync(path, data, options),
      );

      expect(() => publishKiwiWasmArtifact(runtime, wasmFixture)).toThrow(/could not be published durably/);
      expect(runtime.storage.existsSync(kiwiWasmManifestPath(runtime))).toBe(false);
      expect(readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      writeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a file-before-manifest interruption without downloading again', async () => {
    const { root, runtime } = createTestRuntime();
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
    const writeSpy = vi.spyOn(runtime.storage, 'writeAtomicDurableSync');
    try {
      writeSpy.mockImplementation((path, data, options) => {
        if (path === kiwiWasmManifestPath(runtime)) {
          return false;
        }
        return writeAtomicDurableSync(path, data, options);
      });

      expect(() => publishKiwiWasmArtifact(runtime, wasmFixture)).toThrow(/manifest could not be published/);
      expect(inspectKiwiWasmArtifact(runtime)).toMatchObject({
        installed: false,
        payloadValid: true,
        reason: 'manifest_missing_or_invalid',
      });
      expect(readdirSync(kiwiWasmDir(runtime)).some((name) => name.endsWith('.tmp'))).toBe(false);

      writeSpy.mockRestore();
      const download = vi.fn();
      const recovered = await ensureKiwiWasmArtifactLocked(runtime, { download });

      expect(recovered.installed).toBe(true);
      expect(download).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
