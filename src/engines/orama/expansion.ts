import type { Expansion } from '#src/expansion/contract.js';

import { createOramaBaseProjection } from './backend.js';
import { createOramaBacked, createOramaFtsBacked } from './index.js';

const oramaExpansion: Expansion = (host) => {
  const projection = createOramaBaseProjection(host.kb);
  host.registerConsumer(projection, host.scope);
  host.bind(host.kb.vector, createOramaBacked(host.kb, projection));
  host.bind(host.kb.fts, createOramaFtsBacked(host.kb, projection));
};

export default oramaExpansion;
