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
      path: 'src/providers/serviceability.ts',
      symbol: 'createBuiltInProviderHostAdmission',
    },
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

type LocalFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function namedFunctions(sourceFile: ts.SourceFile): ReadonlyMap<string, LocalFunction> {
  const functions = new Map<string, LocalFunction>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
      ) {
        functions.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return functions;
}

function calledLocalFunctions(
  declaration: LocalFunction,
  functions: ReadonlyMap<string, LocalFunction>,
): readonly string[] {
  const called = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && functions.has(node.expression.text)) {
      called.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return [...called];
}

/**
 * Follow same-module function calls from each semantic root. This is intentionally source-derived: helpers
 * extracted from a decision remain in the guarded closure without requiring a second hand-maintained list.
 * Function expressions nested inside a declaration are already part of that declaration's scanned syntax;
 * calls they make to top-level helpers are discovered by the same walk.
 */
function localDecisionClosure(
  roots: readonly DecisionSymbol[],
  sourceFiles: ReadonlyMap<string, ts.SourceFile>,
): readonly DecisionSymbol[] {
  const closure: DecisionSymbol[] = [];
  const seen = new Set<string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const current = queue.shift() as DecisionSymbol;
    const key = `${current.path}\0${current.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    closure.push(current);

    const sourceFile = sourceFiles.get(current.path);
    if (sourceFile === undefined) continue;
    const functions = namedFunctions(sourceFile);
    const declaration = functions.get(current.symbol);
    if (declaration === undefined) continue;
    for (const symbol of calledLocalFunctions(declaration, functions)) {
      queue.push({ path: current.path, symbol });
    }
  }

  return closure;
}

export function serviceabilityDecisionClosureInventory(
  repoRoot: string,
  productionFilePaths: readonly string[],
): Readonly<Record<string, readonly DecisionSymbol[]>> {
  const sourceFiles = new Map(
    productionFilePaths.map((filePath) => {
      const path = toCanonicalSrcPath(repoRoot, filePath);
      return [
        path,
        ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      ] as const;
    }),
  );
  const roots = {
    ...STATIC_SERVICEABILITY_DECISION_SYMBOLS,
    providerClassifiers: providerClassifierFiles(repoRoot, productionFilePaths).flatMap(({ path, sourceFile }) =>
      exportedClassifierNames(sourceFile).map((symbol) => ({ path, symbol })),
    ),
  };
  return Object.fromEntries(
    Object.entries(roots).map(([category, decisions]) => [category, localDecisionClosure(decisions, sourceFiles)]),
  );
}
