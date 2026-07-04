import { createHash } from 'node:crypto';

import type { Backed, EmbeddingService } from '../../kb/contract.js';
import { EMBEDDING_NORMALIZATION, computeEmbeddingSpecId } from '../../kb/embedding-vector.js';
import type { EmbeddingSpec } from './store.js';

type BoundEmbeddingMetadata = {
  readonly name?: string;
  readonly model?: string;
  readonly dims?: number;
  readonly normalization?: EmbeddingSpec['normalization'];
  readonly specId?: string;
};

export type ResolvedNeedleEmbedder = {
  readonly service: EmbeddingService;
  readonly spec: Omit<EmbeddingSpec, 'createdAt'>;
  readonly projectionIdentityHash: string;
};

function asNeedleEmbeddingProvider(service: EmbeddingService): EmbeddingService & BoundEmbeddingMetadata {
  return service as EmbeddingService & BoundEmbeddingMetadata;
}

function computeNeedleProjectionIdentityHash(spec: Omit<EmbeddingSpec, 'createdAt'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: spec.provider,
        model: spec.model,
        dims: spec.dims,
        normalization: spec.normalization,
        specId: spec.specId,
      }),
      'utf8',
    )
    .digest('hex');
}

export function resolveBoundNeedleEmbedder(embedder: Backed<EmbeddingService>): ResolvedNeedleEmbedder {
  const service = asNeedleEmbeddingProvider(embedder.read());
  const provider = typeof service.name === 'string' && service.name.length > 0 ? service.name : embedder.consumer.id;
  const model = typeof service.model === 'string' && service.model.length > 0 ? service.model : provider;
  const dims = service.dims;
  if (typeof dims !== 'number' || !Number.isInteger(dims) || dims <= 0) {
    throw new Error(`Bound embedding service '${embedder.consumer.id}' did not declare a valid dims field.`);
  }

  const normalization = service.normalization === 'none' ? 'none' : EMBEDDING_NORMALIZATION;
  const specId =
    typeof service.specId === 'string' && service.specId.length > 0
      ? service.specId
      : computeEmbeddingSpecId(provider, model, dims, normalization);
  const spec = {
    provider,
    model,
    dims,
    normalization,
    specId,
  };

  return {
    service,
    spec,
    projectionIdentityHash: computeNeedleProjectionIdentityHash(spec),
  };
}
