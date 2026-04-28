import type { Backed, FtsRetrieval, KbRuntime } from '../../kb/contract.js';
import { createOramaBaseProjection, type OramaBaseProjection } from './backend.js';

function asFtsRetrieval(projection: OramaBaseProjection): FtsRetrieval {
  return {
    search(query, topK, scope) {
      return projection.search(query, topK, scope);
    },
    tokenize(text) {
      return projection.tokenize(text);
    },
    warnings() {
      return projection.warnings();
    },
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
export { OramaSnapshotStore } from './snapshot.js';
