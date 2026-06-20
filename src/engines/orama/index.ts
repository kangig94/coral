import type { Backed, FtsRetrieval } from '../../kb/contract.js';
import type { OramaBaseProjection, OramaSearchPort } from './backend.js';

function asFtsRetrieval(searchPort: OramaSearchPort): FtsRetrieval {
  return {
    search(query, topK, scope) {
      return searchPort.search(query, topK, scope);
    },
    tokenize(text) {
      return searchPort.tokenize(text);
    },
    tokenizeBatch(texts) {
      return searchPort.tokenizeBatch(texts);
    },
    warnings() {
      return searchPort.warnings();
    },
  };
}

export function createOramaFtsBacked(
  projection: OramaBaseProjection,
  searchPort: OramaSearchPort = projection.getSearchPort(),
): Backed<FtsRetrieval> {
  const retrieval = asFtsRetrieval(searchPort);
  return {
    read: () => retrieval,
    consumer: projection,
  };
}
