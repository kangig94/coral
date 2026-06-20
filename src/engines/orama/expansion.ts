import type { Expansion } from '#src/expansion/contract.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';
import type { Disposable } from '#src/runtime/ports.js';
import type { ConsumerApplyError } from '#src/store/consumer-contract.js';

import {
  createOramaBaseProjection,
  type OramaAnalyzerManager,
  type OramaReconcileReason,
} from './backend.js';
import { createOramaFtsBacked } from './index.js';
import { OramaSnapshotStore } from './snapshot.js';
import { createOramaArtifactPort } from './artifact-port.js';

export type OramaExpansionOptions = {
  readonly analyzerManager?: OramaAnalyzerManager;
  readonly requestProjectionReconcile?: (reason: OramaReconcileReason) => void;
  readonly onApplyFailure?: (error: ConsumerApplyError) => void;
  readonly registerAnalyzerDegradedObserver?: (scope: Disposable) => void;
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
      ...(options.requestProjectionReconcile === undefined
        ? {}
        : { requestProjectionReconcile: options.requestProjectionReconcile }),
      ...(options.onApplyFailure === undefined ? {} : { onApplyFailure: options.onApplyFailure }),
    });
    const searchPort = projection.getSearchPort();
    const handle = host.registerConsumer(
      {
        id: projection.id,
        authority: projection.authority,
        corpusInterest: projection.corpusInterest,
        kind: projection.kind,
        projectionSync: projection.projectionSync,
        ...(projection.onApplyFailure === undefined ? {} : { onApplyFailure: projection.onApplyFailure }),
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
    options.registerAnalyzerDegradedObserver?.(host.scope);
  };
}

const defaultOramaExpansion = createOramaExpansion();
const oramaExpansion: Expansion = (host) => defaultOramaExpansion(host);

export default oramaExpansion;
