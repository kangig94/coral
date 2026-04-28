import type { Expansion } from '#src/expansion/contract.js';

import { createOramaBaseProjection } from './backend.js';
import { createOramaFtsBacked } from './index.js';
import { OramaSnapshotStore } from './snapshot.js';

const oramaExpansion: Expansion = (host) => {
  const snapshotStore = new OramaSnapshotStore(host.kb.runtimeDir);
  const projection = createOramaBaseProjection(host.kb, snapshotStore);
  host.registerConsumer(projection, host.scope);
  if (host.kb.fts.heldBy === undefined) {
    host.bind(host.kb.fts, createOramaFtsBacked(host.kb, projection));
  }
};

export default oramaExpansion;
