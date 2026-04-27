import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type { Expansion } from '#src/expansion/contract.js';
import type { Backed, EmbeddingService } from '#src/kb/contract.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { EMBEDDING_NORMALIZATION, computeEmbeddingSpecId, normalizeEmbeddingVector } from '../vector.js';
import { fetchWithTransientRetry, isRecord } from '../fetch.js';

const ONNX_DEFAULT_MODEL = 'nomic-embed-text';

const ONNX_MODELS = {
  'nomic-embed-text': {
    dims: 768,
    downloadUrl: 'https://huggingface.co/Xenova/nomic-embed-text-v1/resolve/main/onnx/model.onnx?download=1',
  },
  'bge-m3': {
    dims: 1024,
    downloadUrl: 'https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model.onnx?download=1',
  },
} as const satisfies Record<string, { dims: number; downloadUrl: string }>;

type SupportedOnnxModel = keyof typeof ONNX_MODELS;

type OnnxTensor = {
  data: unknown;
  dims: readonly number[];
  type?: string;
};

type OnnxSession = {
  inputNames: string[];
  outputNames: string[];
  inputMetadata?: Record<string, { type?: string }>;
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
};

type OnnxRuntimeModule = {
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => OnnxTensor;
  InferenceSession: {
    create(modelPath: string): Promise<OnnxSession>;
  };
};

type OnnxEmbeddingService = EmbeddingService & {
  readonly name: 'onnx';
  readonly model: SupportedOnnxModel;
  readonly dims: number;
  readonly normalization: typeof EMBEDDING_NORMALIZATION;
  readonly specId: string;
};

type OnnxExpansionTestHooks = {
  resolveRuntimeModule?: (runtimeDir: string) => OnnxRuntimeModule | null;
  downloadFile?: (url: string, destinationPath: string) => Promise<void>;
};

let onnxExpansionTestHooks: OnnxExpansionTestHooks | null = null;

function isOnnxRuntimeModule(value: unknown): value is OnnxRuntimeModule {
  return (
    isRecord(value) &&
    typeof value.Tensor === 'function' &&
    isRecord(value.InferenceSession) &&
    typeof value.InferenceSession.create === 'function'
  );
}

function toNumericVector(value: unknown): Float32Array {
  if (value instanceof Float32Array) {
    return new Float32Array(value);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    return Float32Array.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Float32Array.from(value as unknown as Iterable<number>);
  }
  throw new Error('ONNX output tensor was not numeric.');
}

function flattenOnnxTensor(tensor: OnnxTensor, dims: number): Float32Array {
  const raw = toNumericVector(tensor.data);
  if (raw.length === dims) {
    return normalizeEmbeddingVector(raw, dims);
  }
  if (raw.length >= dims && tensor.dims.length >= 2 && tensor.dims[tensor.dims.length - 1] === dims) {
    return normalizeEmbeddingVector(raw.slice(0, dims), dims);
  }
  throw new Error(`ONNX model returned ${raw.length} values, expected ${dims}.`);
}

function extractOnnxVector(outputs: Record<string, OnnxTensor>, dims: number): Float32Array {
  const preferredNames = ['sentence_embedding', 'embeddings', 'text_embeds', 'output'];

  for (const name of preferredNames) {
    const tensor = outputs[name];
    if (tensor !== undefined) {
      return flattenOnnxTensor(tensor, dims);
    }
  }

  for (const tensor of Object.values(outputs)) {
    try {
      return flattenOnnxTensor(tensor, dims);
    } catch {
      continue;
    }
  }

  throw new Error('ONNX model did not return a usable embedding tensor.');
}

function buildStringInputFeed(
  ort: OnnxRuntimeModule,
  session: OnnxSession,
  text: string,
  model: string,
): Record<string, OnnxTensor> {
  for (const inputName of session.inputNames) {
    if (session.inputMetadata?.[inputName]?.type === 'string') {
      return { [inputName]: new ort.Tensor('string', [text], [1]) };
    }
  }

  if (session.inputNames.length === 1 && session.inputMetadata?.[session.inputNames[0]] === undefined) {
    return { [session.inputNames[0]]: new ort.Tensor('string', [text], [1]) };
  }

  throw new Error(
    `Local ONNX model "${model}" requires tokenized tensor inputs. Install a raw-string ONNX export or add tokenizer support before using local embeddings.`,
  );
}

async function defaultDownloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetchWithTransientRetry(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.tmp`;
  rmSync(tempPath, { force: true });

  try {
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(tempPath));
    renameSync(tempPath, destinationPath);
  } catch (error: unknown) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function resolveOnnxRuntime(runtimeDir: string): OnnxRuntimeModule | null {
  const runtimeRequire = createRequire(join(runtimeDir, 'package.json'));
  let resolvedPath: string;

  try {
    resolvedPath = runtimeRequire.resolve('onnxruntime-node');
  } catch {
    return null;
  }

  const loaded = runtimeRequire(resolvedPath) as unknown;
  return isOnnxRuntimeModule(loaded) ? loaded : null;
}

function modelPath(dataDir: string, model: SupportedOnnxModel): string {
  return join(dataDir, `${model}.onnx`);
}

export async function ensureOnnxModelAvailable(
  dataDir: string,
  model: SupportedOnnxModel = ONNX_DEFAULT_MODEL,
): Promise<string> {
  const destinationPath = modelPath(dataDir, model);
  if (existsSync(destinationPath)) {
    return destinationPath;
  }

  mkdirSync(dataDir, { recursive: true });
  const download = onnxExpansionTestHooks?.downloadFile ?? defaultDownloadFile;
  await download(ONNX_MODELS[model].downloadUrl, destinationPath);
  return destinationPath;
}

class LocalOnnxProvider implements OnnxEmbeddingService {
  readonly name = 'onnx';
  readonly normalization = EMBEDDING_NORMALIZATION;
  readonly specId: string;
  private sessionPromise: Promise<OnnxSession> | null = null;

  constructor(
    readonly model: SupportedOnnxModel,
    readonly dims: number,
    private readonly ort: OnnxRuntimeModule,
    private readonly modelFilePath: string,
  ) {
    this.specId = computeEmbeddingSpecId(this.name, this.model, this.dims, this.normalization);
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const session = await this.getSession();
    const results: Float32Array[] = [];

    for (const text of texts) {
      const feeds = buildStringInputFeed(this.ort, session, text, this.model);
      const outputs = await session.run(feeds);
      results.push(extractOnnxVector(outputs, this.dims));
    }

    return results;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedDocuments([text]);
    if (vector === undefined) {
      throw new Error('Local ONNX embedding response did not contain a vector.');
    }
    return vector;
  }

  private getSession(): Promise<OnnxSession> {
    this.sessionPromise ??= this.ort.InferenceSession.create(this.modelFilePath);
    return this.sessionPromise;
  }
}

const onnxExpansion: Expansion = async (host) => {
  const dataDir = host.runtime.paths.coral.expansion.dataDir(host.id);
  const runtimeModule = onnxExpansionTestHooks?.resolveRuntimeModule?.(host.kb.runtimeDir) ?? resolveOnnxRuntime(host.kb.runtimeDir);
  if (runtimeModule === null) {
    throw new CoralSetupError({
      code: 'onnx-runtime-missing',
      userMessage: 'ONNX embedding requires onnxruntime-node in the KB runtime.',
      remediation: 'Install onnxruntime-node before equipping the onnx expansion.',
      context: { expansion: host.id, runtimeDir: host.kb.runtimeDir },
    });
  }

  const model = ONNX_DEFAULT_MODEL;
  const modelFilePath = await ensureOnnxModelAvailable(dataDir, model);
  const service = new LocalOnnxProvider(model, ONNX_MODELS[model].dims, runtimeModule, modelFilePath);
  const consumer = {
    id: host.id,
    authority: 'journal' as const,
    registrationKind: 'stateless' as const,
  };
  const provider: Backed<EmbeddingService> = {
    read: () => service,
    consumer,
  };

  host.registerConsumer(consumer, host.scope);
  host.bind(host.kb.embedding, provider);
};

export function __setOnnxExpansionTestHooks(hooks: OnnxExpansionTestHooks | null): void {
  onnxExpansionTestHooks = hooks;
}

export default onnxExpansion;
