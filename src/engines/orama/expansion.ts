import type { Expansion } from '#src/expansion/contract.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';

import { createOramaBaseProjection, type OramaAnalyzerManager } from './backend.js';
import { createOramaFtsBacked } from './index.js';
import { OramaSnapshotStore } from './snapshot.js';
import { createOramaArtifactPort } from './artifact-port.js';

export type OramaExpansionOptions = {
  readonly analyzerManager?: OramaAnalyzerManager;
};

const EMPTY_ANALYZERS = [] as const;

export function createOramaExpansion(options: OramaExpansionOptions = {}): Expansion {
  return (host) => {
    const analyzerManager = options.analyzerManager;
    const snapshotStore = new OramaSnapshotStore(
      { files: host.kb.projectionArtifacts.files },
      host.kb.projectionArtifacts.runtimeDir,
    );
    const declaredAnalyzers = Array.isArray(host.kb.declaredAnalyzers) ? host.kb.declaredAnalyzers : EMPTY_ANALYZERS;
    const projection = createOramaBaseProjection(host.kb, snapshotStore, {
      kiwiRuntime: host.runtime,
      ...(analyzerManager === undefined ? {} : { analyzerManager }),
    });
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
      createOramaArtifactPort(
        host.kb.projectionArtifacts.files,
        host.kb.projectionArtifacts.runtimeDir,
        declaredAnalyzers,
        analyzerManager === undefined
          ? undefined
          : (declared) => analyzerManager.effectiveDeclaredAnalyzers(declared, host.runtime),
      ),
      { targetConsumerHandles: [handle] },
      host.scope,
    );
    host.bind(KB_FTS_CAPABILITY, createOramaFtsBacked(projection, searchPort));
  };
}

const defaultOramaExpansion = createOramaExpansion();
const oramaExpansion: Expansion = (host) => defaultOramaExpansion(host);

export default oramaExpansion;
