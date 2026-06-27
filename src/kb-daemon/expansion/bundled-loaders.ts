import {
  getKiwiAnalyzerManager,
  isKiwiAnalyzerTerminalLoadError,
  type KiwiAnalyzerDegradedEvent,
  type KiwiAnalyzerManager,
} from '../../engines/kiwi/analyzer-manager.js';
import { createOramaExpansion, type OramaExpansionOptions } from '../../engines/orama/expansion.js';
import type { OramaAnalyzerManager } from '../../engines/orama/analyzer.js';
import type { Expansion } from '../../expansion/contract.js';

function createKiwiAnalyzerManagerPort(manager: KiwiAnalyzerManager = getKiwiAnalyzerManager()): OramaAnalyzerManager {
  return {
    withAnalyzerLease: (runtime, declaredAnalyzers, run) => manager.withAnalyzerLease(runtime, declaredAnalyzers, run),
    effectiveDeclaredAnalyzers: (declaredAnalyzers, runtime) =>
      manager.effectiveDeclaredAnalyzers(declaredAnalyzers, runtime),
    currentAnalyzer: () => manager.currentAnalyzer(),
    isTerminalLoadError: isKiwiAnalyzerTerminalLoadError,
  };
}

export type LifecycleBundledLoaderOptions = Pick<
  OramaExpansionOptions,
  'requestProjectionReconcile' | 'onApplyFailure'
> & {
  readonly requestKiwiDegradedReconcile?: (event: KiwiAnalyzerDegradedEvent) => void;
};

export function createLifecycleBundledLoaders(
  options: LifecycleBundledLoaderOptions = {},
): Readonly<Record<string, Expansion>> {
  const manager = getKiwiAnalyzerManager();
  const requestKiwiDegradedReconcile = options.requestKiwiDegradedReconcile;
  return {
    orama: createOramaExpansion({
      analyzerManager: createKiwiAnalyzerManagerPort(manager),
      ...(options.requestProjectionReconcile === undefined
        ? {}
        : { requestProjectionReconcile: options.requestProjectionReconcile }),
      ...(options.onApplyFailure === undefined ? {} : { onApplyFailure: options.onApplyFailure }),
      ...(requestKiwiDegradedReconcile === undefined
        ? {}
        : {
            registerAnalyzerDegradedObserver: (scope) => {
              manager.observeDegraded(scope, requestKiwiDegradedReconcile);
            },
          }),
    }),
  };
}

export const LIFECYCLE_BUNDLED_LOADERS: Readonly<Record<string, Expansion>> = createLifecycleBundledLoaders();
