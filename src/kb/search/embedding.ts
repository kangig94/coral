import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { backendLog } from '../../infra/backend-log.js';
import { isRecord } from '../../infra/json.js';
import { readProcessEnv } from '../../infra/process-env.js';
import { TransientHttpError } from '../../infra/http-errors.js';
import { loadCoralEnv } from '../env.js';
import type { EmbeddingSpec } from './needle/store.js';

const GEMINI_PROVIDER_NAME = 'gemini';
const GEMINI_DEFAULT_MODEL = 'gemini-embedding-001';
const GEMINI_DEFAULT_DIMS = 3072;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_COMPATIBLE_PROVIDER_NAME = 'openai-compatible';
const LOCAL_ONNX_PROVIDER_NAME = 'local-onnx';
const NORMALIZATION = 'l2';

const LOCAL_ONNX_MODELS = {
  'nomic-embed-text': {
    dims: 768,
    downloadUrl: 'https://huggingface.co/Xenova/nomic-embed-text-v1/resolve/main/onnx/model.onnx?download=1',
  },
  'bge-m3': {
    dims: 1024,
    downloadUrl: 'https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model.onnx?download=1',
  },
} as const satisfies Record<string, { dims: number; downloadUrl: string }>;

type SupportedLocalOnnxModel = keyof typeof LOCAL_ONNX_MODELS;

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

type GeminiTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export type EmbeddingProviderKind = 'gemini' | 'openai-compatible' | 'local-onnx';

export type EmbeddingProviderConfig = {
  kind: EmbeddingProviderKind;
  name: string;
  model: string;
  dims: number;
  normalization: EmbeddingSpec['normalization'];
  specId: string;
  apiKey: string | null;
  baseUrl: string | null;
};

export interface EmbeddingProvider {
  name: string;
  model: string;
  dims: number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

function warnAndReturnNull(message: string): null {
  backendLog.warn(`Embedding provider disabled: ${message}`);
  return null;
}

function trimEnv(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readDims(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return fallback;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`CORAL_EMBEDDING_DIMS must be a positive integer, received "${value}".`);
  }

  return parsed;
}

function normalizeVector(rawValues: unknown, dims: number): Float32Array {
  if (!Array.isArray(rawValues) || rawValues.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Embedding response did not contain a numeric vector.');
  }
  if (rawValues.length !== dims) {
    throw new Error(`Embedding response returned ${rawValues.length} dimensions, expected ${dims}.`);
  }

  const vector = Float32Array.from(rawValues);
  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }

  if (magnitude === 0) {
    return vector;
  }

  const scale = 1 / Math.sqrt(magnitude);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] *= scale;
  }
  return vector;
}

function isOnnxRuntimeModule(value: unknown): value is OnnxRuntimeModule {
  return (
    isRecord(value) &&
    typeof value.Tensor === 'function' &&
    isRecord(value.InferenceSession) &&
    typeof value.InferenceSession.create === 'function'
  );
}

const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_BASE_MS = 1_000;

async function fetchWithTransientRetry(input: string, init?: RequestInit): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt++) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !TransientHttpError.isTransientStatus(response.status)) {
        return response;
      }
      lastError = new TransientHttpError(response.status, `${response.status} ${response.statusText}`);
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < TRANSIENT_RETRY_LIMIT) {
      const delayMs = TRANSIENT_RETRY_BASE_MS * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError ?? new Error('fetch failed');
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Embedding request failed (${response.status} ${response.statusText}): ${await response.text()}`);
  }
  return response.json();
}

function geminiModelPath(model: string): string {
  return `models/${model}`;
}

function localModelPath(runtimeDir: string, model: SupportedLocalOnnxModel): string {
  return join(dirname(dirname(runtimeDir)), 'models', `${model}.onnx`);
}

function isSupportedLocalOnnxModel(model: string): model is SupportedLocalOnnxModel {
  return Object.hasOwn(LOCAL_ONNX_MODELS, model);
}

function resolveOpenAIEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`;
}

function buildGeminiHeaders(apiKey: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function buildOpenAIHeaders(apiKey: string | null): HeadersInit {
  return {
    'content-type': 'application/json',
    ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
  };
}

function parseGeminiEmbeddingResponse(payload: unknown, dims: number): Float32Array {
  if (!isRecord(payload) || !isRecord(payload.embedding)) {
    throw new Error('Gemini embedding response is missing the embedding payload.');
  }

  return normalizeVector(payload.embedding.values, dims);
}

function parseGeminiBatchResponse(payload: unknown, dims: number): Float32Array[] {
  if (!isRecord(payload) || !Array.isArray(payload.embeddings)) {
    throw new Error('Gemini batch embedding response is missing embeddings.');
  }

  return payload.embeddings.map((embedding) => {
    if (!isRecord(embedding)) {
      throw new Error('Gemini batch embedding response contained an invalid embedding.');
    }
    return normalizeVector(embedding.values, dims);
  });
}

function parseOpenAIEmbeddingResponse(payload: unknown, dims: number): Float32Array[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('OpenAI-compatible embedding response is missing data.');
  }

  return [...payload.data]
    .map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error('OpenAI-compatible embedding response contained an invalid data row.');
      }
      const rowIndex = typeof entry.index === 'number' ? entry.index : index;
      return {
        index: rowIndex,
        vector: normalizeVector(entry.embedding, dims),
      };
    })
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.vector);
}

function chunkTexts<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
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

async function ensureLocalModel(runtimeDir: string, model: SupportedLocalOnnxModel): Promise<string> {
  const modelPath = localModelPath(runtimeDir, model);
  if (existsSync(modelPath)) {
    return modelPath;
  }

  await downloadFile(LOCAL_ONNX_MODELS[model].downloadUrl, modelPath);
  return modelPath;
}

function toNumericVector(value: unknown): Float32Array {
  if (value instanceof Float32Array) {
    return new Float32Array(value);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    return Float32Array.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Float32Array.from(value as unknown as ArrayLike<number>);
  }
  throw new Error('ONNX output tensor was not numeric.');
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

function flattenOnnxTensor(tensor: OnnxTensor, dims: number): Float32Array {
  const raw = toNumericVector(tensor.data);
  if (raw.length === dims) {
    return normalizeVector([...raw], dims);
  }
  if (raw.length >= dims && tensor.dims.length >= 2 && tensor.dims[tensor.dims.length - 1] === dims) {
    return normalizeVector([...raw.slice(0, dims)], dims);
  }
  throw new Error(`ONNX model returned ${raw.length} values, expected ${dims}.`);
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

export function computeSpecId(
  provider: string,
  model: string,
  dims: number,
  normalization: EmbeddingSpec['normalization'],
): string {
  return createHash('sha256').update(JSON.stringify({ provider, model, dims, normalization })).digest('hex');
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = GEMINI_PROVIDER_NAME;

  constructor(
    private readonly apiKey: string,
    readonly model: string = GEMINI_DEFAULT_MODEL,
    readonly dims: number = GEMINI_DEFAULT_DIMS,
  ) {}

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    if (texts.length === 1) {
      return [await this.embedContent(texts[0], 'RETRIEVAL_DOCUMENT')];
    }

    const endpoint = `${GEMINI_API_BASE}/${geminiModelPath(this.model)}:batchEmbedContents`;
    const results: Float32Array[] = [];

    for (const batch of chunkTexts(texts, 100)) {
      const payload = await parseJsonResponse(
        await fetchWithTransientRetry(endpoint, {
          method: 'POST',
          headers: buildGeminiHeaders(this.apiKey),
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: geminiModelPath(this.model),
              content: { parts: [{ text }] },
              taskType: 'RETRIEVAL_DOCUMENT',
              outputDimensionality: this.dims,
            })),
          }),
        }),
      );
      results.push(...parseGeminiBatchResponse(payload, this.dims));
    }

    return results;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embedContent(text, 'RETRIEVAL_QUERY');
  }

  private async embedContent(text: string, taskType: GeminiTaskType): Promise<Float32Array> {
    const endpoint = `${GEMINI_API_BASE}/${geminiModelPath(this.model)}:embedContent`;
    const payload = await parseJsonResponse(
      await fetchWithTransientRetry(endpoint, {
        method: 'POST',
        headers: buildGeminiHeaders(this.apiKey),
        body: JSON.stringify({
          model: geminiModelPath(this.model),
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: this.dims,
        }),
      }),
    );
    return parseGeminiEmbeddingResponse(payload, this.dims);
  }
}

export class OpenAICompatibleProvider implements EmbeddingProvider {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    readonly model: string,
    readonly dims: number,
  ) {}

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const payload = await parseJsonResponse(
      await fetchWithTransientRetry(resolveOpenAIEndpoint(this.baseUrl), {
        method: 'POST',
        headers: buildOpenAIHeaders(this.apiKey),
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dims,
        }),
      }),
    );
    return parseOpenAIEmbeddingResponse(payload, this.dims);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedDocuments([text]);
    if (vector === undefined) {
      throw new Error('OpenAI-compatible embedding response did not contain a vector.');
    }
    return vector;
  }
}

export class LocalOnnxProvider implements EmbeddingProvider {
  private sessionPromise: Promise<OnnxSession> | null = null;

  constructor(
    readonly name: string,
    readonly model: SupportedLocalOnnxModel,
    readonly dims: number,
    private readonly ort: OnnxRuntimeModule,
    private readonly modelPath: string,
  ) {}

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
    this.sessionPromise ??= this.ort.InferenceSession.create(this.modelPath);
    return this.sessionPromise;
  }
}

function resolveEmbeddingKind(
  providerName: string | null,
  model: string | null,
  baseUrl: string | null,
  apiKey: string | null,
): 'gemini' | 'openai-compatible' | 'local-onnx' | null {
  if (providerName !== null) {
    switch (providerName) {
      case 'gemini':
        return 'gemini';
      case 'openai':
      case 'voyage':
      case 'ollama':
      case OPENAI_COMPATIBLE_PROVIDER_NAME:
        return 'openai-compatible';
      case 'local':
      case 'local-onnx':
      case 'onnx':
        return 'local-onnx';
      default:
        throw new Error(`Unsupported CORAL_EMBEDDING_PROVIDER "${providerName}".`);
    }
  }

  if (baseUrl !== null) {
    return 'openai-compatible';
  }
  if (apiKey !== null) {
    return 'gemini';
  }
  if (model !== null && isSupportedLocalOnnxModel(model)) {
    return 'local-onnx';
  }
  return null;
}

function resolveOnnxRuntime(runtimeDir: string): OnnxRuntimeModule | null {
  const runtimeRequire = createRequire(join(runtimeDir, 'node_modules'));
  let resolvedPath: string;

  try {
    resolvedPath = runtimeRequire.resolve('onnxruntime-node');
  } catch {
    return null;
  }

  const loaded = runtimeRequire(resolvedPath) as unknown;
  return isOnnxRuntimeModule(loaded) ? loaded : null;
}

type EnvReader = (key: string) => string | undefined;

/** Resolves embedding configuration from Coral env so indexers share one vector spec. */
export function resolveEmbeddingProviderConfig(env: EnvReader = readProcessEnv): EmbeddingProviderConfig | null {
  loadCoralEnv();

  const configuredProvider = trimEnv(env('CORAL_EMBEDDING_PROVIDER'))?.toLowerCase() ?? null;
  const configuredModel = trimEnv(env('CORAL_EMBEDDING_MODEL'));
  const configuredBaseUrl = trimEnv(env('CORAL_EMBEDDING_BASE_URL'));
  const configuredApiKey = trimEnv(env('CORAL_EMBEDDING_API_KEY'));
  const providerKind = resolveEmbeddingKind(configuredProvider, configuredModel, configuredBaseUrl, configuredApiKey);

  if (providerKind === null) {
    return null;
  }

  if (providerKind === 'gemini') {
    if (configuredApiKey === null) {
      throw new Error('CORAL_EMBEDDING_API_KEY is required for Gemini embeddings.');
    }
    const dims = readDims(env('CORAL_EMBEDDING_DIMS'), GEMINI_DEFAULT_DIMS);
    if (dims === null) {
      throw new Error('Could not determine Gemini embedding dimensions.');
    }
    const model = configuredModel ?? GEMINI_DEFAULT_MODEL;
    return {
      kind: 'gemini',
      name: GEMINI_PROVIDER_NAME,
      model,
      dims,
      normalization: NORMALIZATION,
      specId: computeSpecId(GEMINI_PROVIDER_NAME, model, dims, NORMALIZATION),
      apiKey: configuredApiKey,
      baseUrl: null,
    };
  }

  if (providerKind === 'openai-compatible') {
    if (configuredBaseUrl === null) {
      throw new Error('CORAL_EMBEDDING_BASE_URL is required for OpenAI-compatible embeddings.');
    }
    if (configuredModel === null) {
      throw new Error('CORAL_EMBEDDING_MODEL is required for OpenAI-compatible embeddings.');
    }
    const dims = readDims(env('CORAL_EMBEDDING_DIMS'), null);
    if (dims === null) {
      throw new Error('CORAL_EMBEDDING_DIMS is required for OpenAI-compatible embeddings.');
    }
    const name = configuredProvider ?? OPENAI_COMPATIBLE_PROVIDER_NAME;
    return {
      kind: 'openai-compatible',
      name,
      model: configuredModel,
      dims,
      normalization: NORMALIZATION,
      specId: computeSpecId(name, configuredModel, dims, NORMALIZATION),
      apiKey: configuredApiKey,
      baseUrl: configuredBaseUrl,
    };
  }

  if (configuredModel === null || !isSupportedLocalOnnxModel(configuredModel)) {
    throw new Error(
      `CORAL_EMBEDDING_MODEL must be one of ${Object.keys(LOCAL_ONNX_MODELS).join(', ')} for local ONNX embeddings.`,
    );
  }

  const name = configuredProvider ?? LOCAL_ONNX_PROVIDER_NAME;
  const dims = LOCAL_ONNX_MODELS[configuredModel].dims;
  return {
    kind: 'local-onnx',
    name,
    model: configuredModel,
    dims,
    normalization: NORMALIZATION,
    specId: computeSpecId(name, configuredModel, dims, NORMALIZATION),
    apiKey: null,
    baseUrl: null,
  };
}

/** Creates the configured embedding provider or returns null when embeddings are disabled. */
export async function createEmbeddingProvider(
  runtimeDir: string,
  config?: EmbeddingProviderConfig | null,
  env: EnvReader = readProcessEnv,
): Promise<EmbeddingProvider | null> {
  try {
    const resolvedConfig = config === undefined ? resolveEmbeddingProviderConfig(env) : config;
    if (resolvedConfig === null) {
      return null;
    }

    if (resolvedConfig.kind === 'gemini') {
      if (resolvedConfig.apiKey === null) {
        return warnAndReturnNull('CORAL_EMBEDDING_API_KEY is required for Gemini embeddings.');
      }
      return new GeminiEmbeddingProvider(resolvedConfig.apiKey, resolvedConfig.model, resolvedConfig.dims);
    }

    if (resolvedConfig.kind === 'openai-compatible') {
      if (resolvedConfig.baseUrl === null) {
        return warnAndReturnNull('CORAL_EMBEDDING_BASE_URL is required for OpenAI-compatible embeddings.');
      }
      return new OpenAICompatibleProvider(
        resolvedConfig.name,
        resolvedConfig.baseUrl,
        resolvedConfig.apiKey,
        resolvedConfig.model,
        resolvedConfig.dims,
      );
    }

    const ort = resolveOnnxRuntime(runtimeDir);
    if (ort === null) {
      return warnAndReturnNull(`onnxruntime-node is not installed in the KB runtime dir: ${runtimeDir}`);
    }

    const model = resolvedConfig.model as SupportedLocalOnnxModel;
    let modelPath: string;
    try {
      modelPath = await ensureLocalModel(runtimeDir, model);
    } catch (error: unknown) {
      return warnAndReturnNull(
        `Failed to download local ONNX model "${resolvedConfig.model}" to ${localModelPath(runtimeDir, model)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return new LocalOnnxProvider(resolvedConfig.name, model, resolvedConfig.dims, ort, modelPath);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return warnAndReturnNull(error.message);
    }
    return warnAndReturnNull(String(error));
  }
}

export const EMBEDDING_NORMALIZATION: EmbeddingSpec['normalization'] = NORMALIZATION;
