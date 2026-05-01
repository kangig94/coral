import type { Expansion } from '#src/expansion/contract.js';

import { createOramaBaseProjection } from './backend.js';
import { createOramaFtsBacked } from './index.js';
import { OramaSnapshotStore } from './snapshot.js';
import { createOramaArtifactPort } from './artifact-port.js';

const oramaExpansion: Expansion = (host) => {
  if (host.kb.fts.heldBy === undefined) {
    const snapshotStore = new OramaSnapshotStore(
      { files: host.kb.projectionArtifacts.files },
      host.kb.projectionArtifacts.runtimeDir,
    );
    const projection = createOramaBaseProjection(host.kb, snapshotStore);
    const searchPort = projection.createSearchPort();
    const handle = host.registerConsumer(
      {
        id: projection.id,
        authority: projection.authority,
        corpusInterest: projection.corpusInterest,
        kind: projection.kind,
        projectionSync: projection.projectionSync,
        apply: (ctx) => projection.apply(ctx),
      },
      host.scope,
    );
    host.registerArtifactPort(
      createOramaArtifactPort(host.kb.projectionArtifacts.files, host.kb.projectionArtifacts.runtimeDir),
      { targetConsumerHandles: [handle] },
      host.scope,
    );
    host.bind(host.kb.fts, createOramaFtsBacked(projection, searchPort));
  }
};

export default oramaExpansion;
