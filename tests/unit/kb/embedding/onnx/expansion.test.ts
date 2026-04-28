import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadExpansions } from '#src/expansion/loader.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';
import { __setOnnxExpansionTestHooks } from '#src/kb/embedding/onnx/expansion.js';

const ONNX_ENTRY = {
  id: 'onnx',
  version: '0.5.2',
  specifier: '#src/kb/embedding/onnx/expansion.js',
  metadata: {
    description: 'Local ONNX embedding model',
    onboarding: 'required' as const,
    slot: 'kb.embedding',
  },
};

const createdHomes: string[] = [];

function createFixtureRuntime() {
  const home = mkdtempSync(join(tmpdir(), 'coral-onnx-expansion-home-'));
  createdHomes.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  return createRealRuntime('prod');
}

function createFakeOrt() {
  return {
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: unknown,
        readonly dims: readonly number[],
      ) {}
    },
    InferenceSession: {
      create: vi.fn(async () => ({
        inputNames: ['text'],
        outputNames: ['sentence_embedding'],
        run: vi.fn(async () => ({
          sentence_embedding: {
            data: new Float32Array(768),
            dims: [1, 768] as const,
          },
        })),
      })),
    },
  };
}

afterEach(() => {
  __setOnnxExpansionTestHooks(null);
  vi.unstubAllEnvs();
  for (const home of createdHomes.splice(0).reverse()) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('onnx expansion', () => {
  it('equips and binds kb.embedding with a stateless consumer', async () => {
    const runtime = createFixtureRuntime();
    const downloadFile = vi.fn(async (_url: string, destinationPath: string) => {
      mkdirSync(dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, 'onnx-model', 'utf-8');
    });
    __setOnnxExpansionTestHooks({
      resolveRuntimeModule: () => createFakeOrt(),
      downloadFile,
    });

    const { kb, makeHost } = createTestRuntime({ runtime });
    const [scope] = await loadExpansions(makeHost, [ONNX_ENTRY]);

    try {
      const cachedModelPath = join(runtime.paths.coral.engine.dataDir('onnx'), 'nomic-embed-text.onnx');
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(existsSync(cachedModelPath)).toBe(true);
      expect(kb.embedding.heldBy).toBe('onnx');
      expect(kb.embedding.read().consumer).toMatchObject({
        id: 'onnx',
        authority: 'journal',
        registrationKind: 'stateless',
      });
      expect(kb.embedding.read().read()).toMatchObject({
        name: 'onnx',
        model: 'nomic-embed-text',
        dims: 768,
        normalization: 'l2',
      });
    } finally {
      scope?.[Symbol.dispose]();
    }
  });

  it('downloads the model lazily on first equip and reuses the cache later', async () => {
    const runtime = createFixtureRuntime();
    const downloadFile = vi.fn(async (_url: string, destinationPath: string) => {
      mkdirSync(dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, 'onnx-model', 'utf-8');
    });
    __setOnnxExpansionTestHooks({
      resolveRuntimeModule: () => createFakeOrt(),
      downloadFile,
    });

    const { makeHost } = createTestRuntime({ runtime });
    const [firstScope] = await loadExpansions(makeHost, [ONNX_ENTRY]);
    firstScope?.[Symbol.dispose]();

    expect(downloadFile).toHaveBeenCalledTimes(1);
    downloadFile.mockClear();

    const [secondScope] = await loadExpansions(makeHost, [ONNX_ENTRY]);
    secondScope?.[Symbol.dispose]();

    expect(downloadFile).not.toHaveBeenCalled();
  });
});
