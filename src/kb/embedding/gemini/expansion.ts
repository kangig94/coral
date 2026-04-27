import type { Expansion } from '#src/expansion/contract.js';
import type { Backed, EmbeddingService } from '#src/kb/contract.js';
import { EMBEDDING_NORMALIZATION, computeEmbeddingSpecId, normalizeEmbeddingVector } from '../vector.js';
import { fetchWithTransientRetry, isRecord } from '../fetch.js';
import { CoralSetupError } from '#src/runtime/errors.js';

export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';
export const GEMINI_DEFAULT_MODEL = 'gemini-embedding-001';
export const GEMINI_DEFAULT_DIMS = 3072;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

type GeminiTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

type GeminiEmbeddingService = EmbeddingService & {
  readonly name: 'gemini';
  readonly model: string;
  readonly dims: number;
  readonly normalization: typeof EMBEDDING_NORMALIZATION;
  readonly specId: string;
};

function trimEnv(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function geminiModelPath(model: string): string {
  return `models/${model}`;
}

function buildGeminiHeaders(apiKey: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Gemini embedding request failed (${response.status} ${response.statusText}): ${await response.text()}`);
  }
  return response.json();
}

function parseGeminiEmbeddingResponse(payload: unknown, dims: number): Float32Array {
  if (!isRecord(payload) || !isRecord(payload.embedding)) {
    throw new Error('Gemini embedding response is missing the embedding payload.');
  }

  return normalizeEmbeddingVector(payload.embedding.values, dims);
}

function parseGeminiBatchResponse(payload: unknown, dims: number): Float32Array[] {
  if (!isRecord(payload) || !Array.isArray(payload.embeddings)) {
    throw new Error('Gemini batch embedding response is missing embeddings.');
  }

  return payload.embeddings.map((embedding) => {
    if (!isRecord(embedding)) {
      throw new Error('Gemini batch embedding response contained an invalid embedding.');
    }
    return normalizeEmbeddingVector(embedding.values, dims);
  });
}

function chunkTexts<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push([...values.slice(index, index + size)]);
  }
  return chunks;
}

class GeminiEmbeddingProvider implements GeminiEmbeddingService {
  readonly name = 'gemini';
  readonly normalization = EMBEDDING_NORMALIZATION;
  readonly specId: string;

  constructor(
    private readonly apiKey: string,
    readonly model: string = GEMINI_DEFAULT_MODEL,
    readonly dims: number = GEMINI_DEFAULT_DIMS,
  ) {
    this.specId = computeEmbeddingSpecId(this.name, this.model, this.dims, this.normalization);
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    if (texts.length === 1) {
      return [await this.embedContent(texts[0] ?? '', 'RETRIEVAL_DOCUMENT')];
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

const geminiExpansion: Expansion = (host) => {
  const apiKey = trimEnv(host.runtime.env.get(GEMINI_API_KEY_ENV));
  if (apiKey === null) {
    throw new CoralSetupError({
      code: 'gemini-api-key-missing',
      userMessage: 'Gemini embedding requires GEMINI_API_KEY.',
      remediation: 'Set GEMINI_API_KEY before equipping the gemini expansion.',
      context: { env: GEMINI_API_KEY_ENV, expansion: host.id },
    });
  }

  const service = new GeminiEmbeddingProvider(apiKey);
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

export default geminiExpansion;
