import type { Backed, FtsRetrieval } from '../../kb/contract.js';
import type { CorpusConsumerRegistration } from '../../store/consumer-contract.js';
import type { OramaArtifactPort } from './artifact-port.js';
import type { OramaBaseProjection } from './base-projection.js';
import type { OramaSearchPort } from './search-port.js';

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

type OramaCorpusConsumerRegistration = Omit<CorpusConsumerRegistration, 'registrationKind'> & {
  readonly registrationKind?: never;
};

export function createOramaCorpusConsumerRegistration(
  projection: OramaBaseProjection,
  artifactPort: Pick<OramaArtifactPort, 'projectionIdentityHash' | 'readAuthoritativeFreshness'>,
): OramaCorpusConsumerRegistration {
  return {
    id: projection.id,
    authority: projection.authority,
    corpusInterest: projection.corpusInterest,
    kind: projection.kind,
    projectionSync: projection.projectionSync,
    ...(projection.onApplyFailure === undefined ? {} : { onApplyFailure: projection.onApplyFailure }),
    projectionIdentityHash: () => artifactPort.projectionIdentityHash(),
    readAuthoritativeFreshness: (target) => artifactPort.readAuthoritativeFreshness(target),
    apply: (ctx) => projection.apply(ctx),
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
