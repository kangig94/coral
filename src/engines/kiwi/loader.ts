import { randomUUID } from 'node:crypto';

import { Match, type Kiwi, type ModelFiles, type TokenInfo } from 'kiwi-nlp';
import initKiwiModule from 'kiwi-nlp/dist/build/kiwi-wasm.js';

import type { Runtime } from '../../runtime/ports.js';
import { KIWI_MODEL_FILES, KIWI_MODEL_TYPE, KIWI_MODEL_VERSION, KIWI_NLP_VERSION } from './constants.js';
import { ensureKiwiModelArtifact, inspectKiwiModelArtifact } from './model-artifact.js';
import { kiwiModelFilePath, kiwiWasmPath } from './paths.js';

export type KiwiAnalyzerIdentity = {
  readonly engine: 'kiwi';
  readonly kiwiNlpVersion: string;
  readonly modelVersion: string;
  readonly modelType: typeof KIWI_MODEL_TYPE;
};

export type KiwiAnalyzer = {
  readonly identity: KiwiAnalyzerIdentity;
  readonly kiwi: Kiwi;
  tokenize(text: string): readonly TokenInfo[];
  tokens(text: string): readonly string[];
  dispose(): Promise<void>;
};

export type LoadKiwiAnalyzerOptions = {
  readonly installIfMissing?: boolean;
};

function readBinaryFile(runtime: Pick<Runtime, 'storage'>, path: string): Uint8Array {
  const readFileSync = runtime.storage.readFileSync as unknown as (filePath: string) => Uint8Array | Buffer;
  const content = readFileSync(path);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function readModelFiles(runtime: Pick<Runtime, 'paths' | 'storage'>): ModelFiles {
  const modelFiles: ModelFiles = {};
  for (const fileName of KIWI_MODEL_FILES) {
    modelFiles[fileName] = readBinaryFile(runtime, kiwiModelFilePath(runtime, fileName));
  }
  return modelFiles;
}

type KiwiWasmModule = {
  readonly FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
  api(command: string): string;
};

type KiwiWasmInitializer = (moduleArg?: Record<string, unknown>) => Promise<unknown>;

const initKiwi = initKiwiModule as unknown as KiwiWasmInitializer;

type KiwiApi = {
  cmd<T = unknown>(command: Record<string, unknown>): T;
  loadModelFiles(files: ModelFiles): Promise<{
    readonly modelPath: string;
    unload(): Promise<void>;
  }>;
};

function createKiwiProxy(api: KiwiApi, id: number): Kiwi {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return undefined;
        }
        return (...methodArgs: unknown[]) =>
          api.cmd({
            method: prop.toString(),
            id,
            args: methodArgs,
          });
      },
    },
  ) as Kiwi;
}

async function createKiwiApi(): Promise<KiwiApi> {
  const kiwi = (await initKiwi({
    locateFile: (path: string) => (path.endsWith('.wasm') ? kiwiWasmPath() : path),
  })) as KiwiWasmModule;

  return {
    cmd<T = unknown>(command: Record<string, unknown>): T {
      return JSON.parse(kiwi.api(JSON.stringify(command))) as T;
    },
    async loadModelFiles(files: ModelFiles) {
      const modelPath = `kiwi-model-${randomUUID()}`;
      kiwi.FS.mkdir(modelPath);
      const loadedFiles: string[] = [];
      try {
        for (const [name, data] of Object.entries(files)) {
          if (typeof data === 'string') {
            throw new Error('Kiwi model files must be installed locally before loading.');
          }
          const path = `${modelPath}/${name}`;
          kiwi.FS.writeFile(path, data as Uint8Array);
          loadedFiles.push(path);
        }
      } catch (error: unknown) {
        for (const path of loadedFiles.reverse()) {
          try {
            kiwi.FS.unlink(path);
          } catch {
            /* best-effort cleanup */
          }
        }
        try {
          kiwi.FS.rmdir(modelPath);
        } catch {
          /* best-effort cleanup */
        }
        throw error;
      }

      return {
        modelPath,
        async unload(): Promise<void> {
          for (const path of loadedFiles.reverse()) {
            try {
              kiwi.FS.unlink(path);
            } catch {
              /* best-effort cleanup */
            }
          }
          try {
            kiwi.FS.rmdir(modelPath);
          } catch {
            /* best-effort cleanup */
          }
        },
      };
    },
  };
}

async function buildDisposableKiwi(modelFiles: ModelFiles): Promise<{
  readonly kiwi: Kiwi;
  dispose(): Promise<void>;
}> {
  const api = await createKiwiApi();
  const loadedModel = await api.loadModelFiles(modelFiles);
  let disposed = false;
  try {
    const buildArgs: Record<string, unknown> = {
      modelType: KIWI_MODEL_TYPE,
      modelPath: loadedModel.modelPath,
    };
    const id = api.cmd<number>({
      method: 'build',
      args: [buildArgs],
    });
    return {
      kiwi: createKiwiProxy(api, id),
      async dispose(): Promise<void> {
        if (disposed) {
          return;
        }
        disposed = true;
        await loadedModel.unload();
      },
    };
  } catch (error: unknown) {
    await loadedModel.unload();
    throw error;
  }
}

export function kiwiAnalyzerIdentity(): KiwiAnalyzerIdentity {
  return {
    engine: 'kiwi',
    kiwiNlpVersion: KIWI_NLP_VERSION,
    modelVersion: KIWI_MODEL_VERSION,
    modelType: KIWI_MODEL_TYPE,
  };
}

export async function loadKiwiAnalyzer(
  runtime: Runtime,
  options: LoadKiwiAnalyzerOptions = {},
): Promise<KiwiAnalyzer> {
  if (options.installIfMissing === true) {
    const result = await ensureKiwiModelArtifact(runtime);
    if (result.status === 'error') {
      throw new Error(result.userMessage);
    }
  }

  const state = inspectKiwiModelArtifact(runtime);
  if (!state.installed) {
    throw new Error('Kiwi model artifact is not installed. Run `coral equip kiwi` to install it.');
  }

  const loaded = await buildDisposableKiwi(readModelFiles(runtime));
  const { kiwi } = loaded;

  if (!kiwi.ready()) {
    await loaded.dispose();
    throw new Error('Kiwi analyzer was constructed but is not ready.');
  }

  let disposed = false;
  return {
    identity: kiwiAnalyzerIdentity(),
    kiwi,
    tokenize(text: string): readonly TokenInfo[] {
      if (disposed) {
        throw new Error('Kiwi analyzer has been disposed.');
      }
      return kiwi.tokenize(text, Match.allWithNormalizing);
    },
    tokens(text: string): readonly string[] {
      if (disposed) {
        throw new Error('Kiwi analyzer has been disposed.');
      }
      return kiwi.tokenize(text, Match.allWithNormalizing).map((token) => token.str);
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await loaded.dispose();
    },
  };
}
