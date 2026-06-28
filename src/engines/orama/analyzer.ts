import type { KbEngineRuntimeBase } from '../../kb/contract.js';
import type { Runtime } from '../../runtime/ports.js';
import type { KbDeclaredAnalyzer } from '../../kb/extra-langs.js';
import type { OramaTokenizerAnalyzer } from './document-builder.js';

export type OramaAnalyzerLeaseContext = {
  readonly analyzer: OramaTokenizerAnalyzer | null;
  readonly activeAnalyzers: readonly KbDeclaredAnalyzer[];
};

export type OramaAnalyzerManager = {
  withAnalyzerLease<T>(
    runtime: Runtime | undefined,
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
    run: (lease: OramaAnalyzerLeaseContext) => T | Promise<T>,
  ): Promise<T>;
  effectiveDeclaredAnalyzers(
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
    runtime?: Runtime,
  ): readonly KbDeclaredAnalyzer[];
  currentAnalyzer(): OramaTokenizerAnalyzer | null;
  isTerminalLoadError?(error: unknown): boolean;
};

export const NOOP_ANALYZER_MANAGER: OramaAnalyzerManager = {
  async withAnalyzerLease(_runtime, declaredAnalyzers, run) {
    return run({ analyzer: null, activeAnalyzers: declaredAnalyzers });
  },
  effectiveDeclaredAnalyzers(declaredAnalyzers) {
    return declaredAnalyzers;
  },
  currentAnalyzer() {
    return null;
  },
};

export function readDeclaredAnalyzers(
  runtime: Pick<KbEngineRuntimeBase, 'declaredAnalyzers'>,
): readonly KbDeclaredAnalyzer[] {
  return Array.isArray(runtime.declaredAnalyzers) ? runtime.declaredAnalyzers : [];
}
