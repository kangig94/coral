import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ensureKiwiArtifact, inspectKiwiArtifact, probeKiwiArtifactIdentity } from '#src/engines/kiwi/artifact.js';
import { KIWI_MODEL_FILES, type KiwiModelFileName } from '#src/engines/kiwi/constants.js';
import { type ensureKiwiModelArtifact, writeKiwiModelFilesAtomicInWorker } from '#src/engines/kiwi/model-artifact.js';
import { withKiwiPackageOperationLock } from '#src/engines/kiwi/operation-lock.js';
import { kiwiModelFilePath, kiwiModelManifestPath, kiwiWasmPath } from '#src/engines/kiwi/paths.js';
import { publishKiwiWasmArtifact } from '#src/engines/kiwi/wasm-artifact.js';
import { installErrorSchema } from '#src/expansion/rpc-contract.js';
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

  it('preserves an existing model while installing only missing WASM', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
      const modelManifestBefore = readFileSync(kiwiModelManifestPath(runtime));
      const modelMtimeBefore = statSync(kiwiModelFilePath(runtime, KIWI_MODEL_FILES[0]), { bigint: true }).mtimeNs;
      const ensureModelArtifact = vi.fn();
      const ensureWasmArtifact = vi.fn(async () => publishKiwiWasmArtifact(runtime, wasmFixture));

      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact,
        ensureWasmArtifact,
      });

      expect(result).toMatchObject({ status: 'installed', method: 'runtime-download' });
      expect(ensureModelArtifact).not.toHaveBeenCalled();
      expect(ensureWasmArtifact).toHaveBeenCalledTimes(1);
      expect(readFileSync(kiwiModelManifestPath(runtime))).toEqual(modelManifestBefore);
      expect(statSync(kiwiModelFilePath(runtime, KIWI_MODEL_FILES[0]), { bigint: true }).mtimeNs).toBe(
        modelMtimeBefore,
      );
      expect(inspectKiwiArtifact(runtime).ready).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves an existing WASM while installing only the missing model', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      publishKiwiWasmArtifact(runtime, wasmFixture);
      const wasmPath = inspectKiwiArtifact(runtime).wasm.wasmPath;
      const wasmBefore = readFileSync(wasmPath);
      const wasmMtimeBefore = statSync(wasmPath, { bigint: true }).mtimeNs;
      const ensureModelArtifact = vi.fn(async () => {
        await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
        return {
          status: 'installed' as const,
          method: 'github-release' as const,
          version: '0.23.0',
          targetDir: root,
        };
      });
      const ensureWasmArtifact = vi.fn();

      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact,
        ensureWasmArtifact,
      });

      expect(result).toMatchObject({ status: 'installed', method: 'runtime-download' });
      expect(ensureModelArtifact).toHaveBeenCalledTimes(1);
      expect(ensureWasmArtifact).not.toHaveBeenCalled();
      expect(statSync(wasmPath).size).toBe(wasmBefore.length);
      expect(readFileSync(wasmPath).compare(wasmBefore)).toBe(0);
      expect(statSync(wasmPath, { bigint: true }).mtimeNs).toBe(wasmMtimeBefore);
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

  it('does no component work when both artifacts are ready', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
      publishKiwiWasmArtifact(runtime, wasmFixture);
      const ensureModelArtifact = vi.fn();
      const ensureWasmArtifact = vi.fn();

      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact,
        ensureWasmArtifact,
      });

      expect(result).toMatchObject({ status: 'already_installed' });
      expect(ensureModelArtifact).not.toHaveBeenCalled();
      expect(ensureWasmArtifact).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('probes model and WASM identity without reading artifact contents', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
      publishKiwiWasmArtifact(runtime, wasmFixture);
      const readFileSpy = vi.spyOn(runtime.storage, 'readFileSync');
      const openSpy = vi.spyOn(runtime.storage, 'openSync');
      const readSpy = vi.spyOn(runtime.storage, 'readSync');

      const before = probeKiwiArtifactIdentity(runtime);
      expect(probeKiwiArtifactIdentity(runtime)).toBe(before);
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();

      runtime.storage.rmSync(kiwiModelFilePath(runtime, KIWI_MODEL_FILES[0]));
      const withoutModelFile = probeKiwiArtifactIdentity(runtime);
      expect(withoutModelFile).not.toBe(before);

      runtime.storage.rmSync(kiwiWasmPath(runtime));
      expect(probeKiwiArtifactIdentity(runtime)).not.toBe(withoutModelFile);
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports already_up_to_date and updated through the observable update contract', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      const ensureModelArtifact = vi.fn(async () => {
        await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles());
        return {
          status: 'updated' as const,
          method: 'github-release' as const,
          version: '0.23.0',
          targetDir: root,
        };
      });
      const ensureWasmArtifact = vi.fn(async () => publishKiwiWasmArtifact(runtime, wasmFixture));

      const result = await ensureKiwiArtifact(runtime, {
        update: true,
        ensureModelArtifact,
        ensureWasmArtifact,
      });

      expect(result.status).toBe('updated');
      expect(inspectKiwiArtifact(runtime).ready).toBe(true);

      await expect(ensureKiwiArtifact(runtime, { update: true })).resolves.toMatchObject({
        status: 'already_up_to_date',
        method: 'runtime-download',
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

  it('hands the composite lock into the real model lock harness without reacquiring it', async () => {
    const { root, runtime } = createTestRuntime();
    let modelWriteRan = false;
    const ensureModelArtifact: typeof ensureKiwiModelArtifact = async (innerRuntime, options = {}) =>
      withKiwiPackageOperationLock(innerRuntime, options, async () => {
        modelWriteRan = true;
        await writeKiwiModelFilesAtomicInWorker(innerRuntime, modelFiles());
        return {
          status: 'installed',
          method: 'github-release',
          version: '0.23.0',
          targetDir: root,
        };
      });
    try {
      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact,
        ensureWasmArtifact: async () => publishKiwiWasmArtifact(runtime, wasmFixture),
        lockTimeoutMs: 25,
      });

      expect(modelWriteRan).toBe(true);
      expect(result).toMatchObject({ status: 'installed', method: 'runtime-download' });
      expect(inspectKiwiArtifact(runtime).ready).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a schema-valid error when installation completes without readiness', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact: async () => ({
          status: 'installed',
          method: 'github-release',
          version: '0.23.0',
          targetDir: root,
        }),
        ensureWasmArtifact: async () => publishKiwiWasmArtifact(runtime, wasmFixture),
      });

      expect(result).toMatchObject({
        status: 'error',
        code: 'expansion_install_artifact_failed',
        context: {
          name: 'kiwi',
          detail: 'Kiwi artifact install completed without readiness: model',
          causeName: 'Error',
          causeMessage: 'Kiwi artifact install completed without readiness: model',
          causeStack: expect.stringContaining('Kiwi artifact install completed without readiness: model'),
        },
      });
      expect(result).not.toHaveProperty('cause');
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(installErrorSchema.safeParse(result).success).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['EACCES', 'EPERM', 'EROFS', 'ENOSPC'])(
    'maps a component %s failure to the structured unwritable-path result',
    async (code) => {
      const { root, runtime } = createTestRuntime();
      try {
        const result = await ensureKiwiArtifact(runtime, {
          ensureModelArtifact: async () => {
            throw Object.assign(new Error(`model ${code}`), { code });
          },
        });

        expect(result).toMatchObject({
          status: 'error',
          code: 'expansion_install_path_unwritable',
          context: { name: 'kiwi' },
        });
        expect(installErrorSchema.safeParse(result).success).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('maps an unrelated component exception to the structured artifact failure', async () => {
    const { root, runtime } = createTestRuntime();
    try {
      const result = await ensureKiwiArtifact(runtime, {
        ensureModelArtifact: async () => {
          throw new Error('model exploded');
        },
      });

      expect(result).toMatchObject({
        status: 'error',
        code: 'expansion_install_artifact_failed',
        context: { name: 'kiwi', detail: 'model exploded' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
