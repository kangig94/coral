import { readFileSync } from 'node:fs';

import ts from 'typescript';

import { toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const CLASSIFIER_PATH = /^src\/providers\/([^/]+)\/serviceability\.ts$/u;

export type DecisionSymbol = Readonly<{ path: string; symbol: string }>;

export const STATIC_SERVICEABILITY_DECISION_SYMBOLS = {
  factPublishers: [
    { path: 'src/providers/host-diagnostics.ts', symbol: 'recordProviderResponseDiagnostic' },
    { path: 'src/providers/app-server-transport.ts', symbol: 'handleProviderServerLine' },
  ],
  classifierDispatchers: [
    { path: 'src/providers/bootstrap.ts', symbol: 'classifyProviderResponseServiceability' },
    { path: 'src/providers/serviceability.ts', symbol: 'classifyProviderResponseServiceability' },
  ],
  serviceabilityReducers: [{ path: 'src/providers/host-serviceability.ts', symbol: 'reduceHostServiceability' }],
  admissionSymbols: [
    { path: 'src/providers/host-admission.ts', symbol: 'reduceHostAdmission' },
    { path: 'src/providers/host-admission.ts', symbol: 'createHostAdmissionCollection' },
  ],
  admissionCompositionLeaves: [
    {
      path: 'src/coordinator/live/provider-host-admission.ts',
      symbol: 'createCoordinatorProviderHostAdmission',
    },
    { path: 'src/provider-proxy/provider-host-admission.ts', symbol: 'createProxyProviderHostAdmission' },
  ],
} satisfies Readonly<Record<string, readonly DecisionSymbol[]>>;

export type ProviderClassifierFile = Readonly<{
  provider: string;
  path: string;
  sourceFile: ts.SourceFile;
}>;

function isExported(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function exportedClassifierNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name !== undefined &&
    isExported(statement) &&
    statement.name.text.startsWith('classify')
      ? [statement.name.text]
      : [],
  );
}

export function providerClassifierFiles(
  repoRoot: string,
  productionFilePaths: readonly string[],
): readonly ProviderClassifierFile[] {
  return productionFilePaths.flatMap((filePath) => {
    const path = toCanonicalSrcPath(repoRoot, filePath);
    const match = CLASSIFIER_PATH.exec(path);
    if (match?.[1] === undefined) return [];
    return [
      {
        provider: match[1],
        path,
        sourceFile: ts.createSourceFile(
          filePath,
          readFileSync(filePath, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      },
    ];
  });
}

export function serviceabilityDecisionClosureInventory(
  repoRoot: string,
  productionFilePaths: readonly string[],
): Readonly<Record<string, readonly DecisionSymbol[]>> {
  return {
    ...STATIC_SERVICEABILITY_DECISION_SYMBOLS,
    providerClassifiers: providerClassifierFiles(repoRoot, productionFilePaths).flatMap(({ path, sourceFile }) =>
      exportedClassifierNames(sourceFile).map((symbol) => ({ path, symbol })),
    ),
  };
}
