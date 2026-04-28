import { createHash } from 'node:crypto';

export type EmbeddingNormalization = 'l2' | 'none';

export const EMBEDDING_NORMALIZATION: EmbeddingNormalization = 'l2';

export function computeEmbeddingSpecId(
  provider: string,
  model: string,
  dims: number,
  normalization: EmbeddingNormalization,
): string {
  return createHash('sha256').update(JSON.stringify({ provider, model, dims, normalization })).digest('hex');
}

export function normalizeEmbeddingVector(rawValues: unknown, dims: number): Float32Array {
  const values = Array.isArray(rawValues)
    ? rawValues
    : ArrayBuffer.isView(rawValues)
      ? Array.from(rawValues as unknown as Iterable<unknown>)
      : null;
  if (values === null || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Embedding response did not contain a numeric vector.');
  }
  if (values.length !== dims) {
    throw new Error(`Embedding response returned ${values.length} dimensions, expected ${dims}.`);
  }

  const vector = Float32Array.from(values);
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
