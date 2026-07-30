import { Match, type Kiwi, type ModelFiles, type TokenInfo } from 'kiwi-nlp';

import type { Runtime } from '../../runtime/ports.js';
import { ensureKiwiArtifact, inspectKiwiArtifact } from './artifact.js';
import { KIWI_MODEL_FILES, KIWI_MODEL_TYPE, KIWI_MODEL_VERSION, KIWI_NLP_VERSION } from './constants.js';
import { kiwiModelFilePath } from './paths.js';
import { createKiwiApi, type KiwiApi } from './wasm-loader.js';

type KiwiAnalyzerIdentity = {
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

export class KiwiAnalyzerMissingArtifactError extends Error {
  constructor(missingComponents: readonly string[]) {
    super(
      `Kiwi runtime artifacts are not installed (${missingComponents.join(', ')} missing). ` +
        'Run `coral-cli expansion equip kiwi` to install them.',
    );
    this.name = 'KiwiAnalyzerMissingArtifactError';
  }
}

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

async function buildDisposableKiwi(
  runtime: Pick<Runtime, 'paths'>,
  modelFiles: ModelFiles,
): Promise<{
  readonly kiwi: Kiwi;
  dispose(): Promise<void>;
}> {
  const api = await createKiwiApi(runtime);
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

function kiwiAnalyzerIdentity(): KiwiAnalyzerIdentity {
  return {
    engine: 'kiwi',
    kiwiNlpVersion: KIWI_NLP_VERSION,
    modelVersion: KIWI_MODEL_VERSION,
    modelType: KIWI_MODEL_TYPE,
  };
}

export async function loadKiwiAnalyzer(runtime: Runtime, options: LoadKiwiAnalyzerOptions = {}): Promise<KiwiAnalyzer> {
  if (options.installIfMissing === true) {
    const result = await ensureKiwiArtifact(runtime);
    if (result.status === 'error') {
      throw new Error(`${result.userMessage} ${result.remediation}`, { cause: result });
    }
  }

  const state = inspectKiwiArtifact(runtime);
  if (!state.ready) {
    throw new KiwiAnalyzerMissingArtifactError(state.missingComponents);
  }

  const loaded = await buildDisposableKiwi(runtime, readModelFiles(runtime));
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
