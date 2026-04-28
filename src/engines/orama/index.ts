import type { Backed, FtsRetrieval, KbRuntime, VectorRetrieval } from '../../kb/contract.js';
import { createOramaBaseProjection, type OramaBaseProjection } from './backend.js';

function asVectorRetrieval(projection: OramaBaseProjection): VectorRetrieval {
  return {
    read(embedding, topK, scope) {
      return projection.search(embedding, topK, scope);
    },
  };
}

function asFtsRetrieval(projection: OramaBaseProjection): FtsRetrieval {
  return {
    read(query, topK, scope) {
      return projection.search(query, topK, scope);
    },
  };
}

export function createOramaBacked(
  runtime: KbRuntime,
  projection: OramaBaseProjection = createOramaBaseProjection(runtime),
): Backed<VectorRetrieval> {
  const retrieval = asVectorRetrieval(projection);
  return {
    read: () => retrieval,
    consumer: projection,
  };
}

export function createOramaFtsBacked(
  runtime: KbRuntime,
  projection: OramaBaseProjection = createOramaBaseProjection(runtime),
): Backed<FtsRetrieval> {
  const retrieval = asFtsRetrieval(projection);
  return {
    read: () => retrieval,
    consumer: projection,
  };
}

export { ORAMA_BASE_CONSUMER_ID, OramaBaseProjection, createOramaBaseProjection } from './backend.js';
