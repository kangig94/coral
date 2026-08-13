import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

export type CallableNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

export type ExecutableCall = ts.CallExpression | ts.NewExpression;

export type ResolvedCallable = DecisionSymbol &
  Readonly<{
    node: CallableNode;
    sourceFile: ts.SourceFile;
  }>;

export type CallableEdge = Readonly<{
  from: DecisionSymbol;
  to: DecisionSymbol;
  kind: 'call' | 'callback';
  site: string;
}>;

export type CallableVisit = ResolvedCallable & Readonly<{ trace: readonly string[] }>;

export type CallableClosureAnalysis = Readonly<{
  roots: readonly ResolvedCallable[];
  callables: readonly CallableVisit[];
  edges: readonly CallableEdge[];
  inspectedCallCount: number;
  unresolvedCalls: readonly string[];
}>;

export type CallableClosureContext = Readonly<{
  repoRoot: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>;
  pathByFileName: ReadonlyMap<string, string>;
}>;

function compilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) throw new Error(`Missing tsconfig.json below ${repoRoot}`);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return { ...parsed.options, incremental: false, noEmit: true, tsBuildInfoFile: undefined };
}

export function createCallableClosureContext(
  repoRoot: string,
  productionFilePaths: readonly string[],
  suppliedProgram?: ts.Program,
): CallableClosureContext {
  const program =
    suppliedProgram ??
    ts.createProgram({
      rootNames: [...productionFilePaths],
      options: compilerOptions(repoRoot),
    });
  const sourceFilesByPath = new Map<string, ts.SourceFile>();
  const pathByFileName = new Map<string, string>();
  for (const filePath of productionFilePaths) {
    const path = toCanonicalSrcPath(repoRoot, filePath);
    const sourceFile = program.getSourceFile(filePath) ?? program.getSourceFile(resolve(filePath));
    if (sourceFile === undefined) throw new Error(`TypeScript program omitted production source ${path}`);
    sourceFilesByPath.set(path, sourceFile);
    pathByFileName.set(resolve(sourceFile.fileName), path);
  }
  return { repoRoot, program, checker: program.getTypeChecker(), sourceFilesByPath, pathByFileName };
}

function callableName(name: ts.PropertyName | undefined): string | undefined {
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function isCallableNode(node: ts.Node): node is CallableNode {
  if (ts.isArrowFunction(node)) return true;
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    node.body !== undefined
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function enclosingClassName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current.name?.text;
    current = current.parent;
  }
  return undefined;
}

function declaredName(node: CallableNode): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return node.name?.text;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return callableName(node.name);
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) return callableName(parent.name);
  return undefined;
}

function isTopLevelCallable(node: CallableNode): boolean {
  if (ts.isFunctionDeclaration(node)) return ts.isSourceFile(node.parent);
  return (
    ts.isVariableDeclaration(node.parent) &&
    ts.isVariableDeclarationList(node.parent.parent) &&
    ts.isVariableStatement(node.parent.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent.parent)
  );
}

function callableSymbol(node: CallableNode, sourceFile: ts.SourceFile): string {
  const name = declaredName(node);
  const className = enclosingClassName(node);
  if (className !== undefined && name !== undefined) return `${className}.${name}`;
  if (name !== undefined && isTopLevelCallable(node)) return name;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${name ?? 'anonymous'}@${line + 1}:${character + 1}`;
}

function sourcePath(context: CallableClosureContext, sourceFile: ts.SourceFile): string | undefined {
  return context.pathByFileName.get(resolve(sourceFile.fileName));
}

function resolvedCallable(context: CallableClosureContext, node: CallableNode): ResolvedCallable | undefined {
  const sourceFile = node.getSourceFile();
  const path = sourcePath(context, sourceFile);
  return path === undefined ? undefined : { path, symbol: callableSymbol(node, sourceFile), node, sourceFile };
}

function aliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
}

function symbolAtExpression(context: CallableClosureContext, expression: ts.Expression): ts.Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) return context.checker.getSymbolAtLocation(unwrapped.name);
  return context.checker.getSymbolAtLocation(unwrapped);
}

function expressionInitializers(declaration: ts.Declaration): readonly ts.Expression[] {
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isBindingElement(declaration)
  ) {
    return declaration.initializer === undefined ? [] : [declaration.initializer];
  }
  return [];
}

function objectMemberTargets(
  context: CallableClosureContext,
  expression: ts.Expression,
  memberName: string | undefined,
  seenSymbols: Set<ts.Symbol>,
): readonly CallableNode[] {
  const unwrapped = unwrapExpression(expression);
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    unwrapped.expression.expression.getText() === 'Object' &&
    unwrapped.expression.name.text === 'freeze' &&
    unwrapped.arguments[0] !== undefined
  ) {
    return objectMemberTargets(context, unwrapped.arguments[0], memberName, seenSymbols);
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return [
      ...objectMemberTargets(context, unwrapped.whenTrue, memberName, seenSymbols),
      ...objectMemberTargets(context, unwrapped.whenFalse, memberName, seenSymbols),
    ];
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) {
        return objectMemberTargets(context, property.expression, memberName, seenSymbols);
      }
      const name = callableName(property.name);
      if (memberName !== undefined && name !== memberName) return [];
      if (ts.isMethodDeclaration(property) && isCallableNode(property)) return [property];
      if (ts.isPropertyAssignment(property)) {
        return expressionTargets(context, property.initializer, new Set(seenSymbols));
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = context.checker.getShorthandAssignmentValueSymbol(property);
        return symbol === undefined ? [] : symbolTargets(context, symbol, new Set(seenSymbols));
      }
      return [];
    });
  }
  const symbol = symbolAtExpression(context, unwrapped);
  if (symbol === undefined) return [];
  return (
    aliasedSymbol(context.checker, symbol).declarations?.flatMap((declaration) =>
      expressionInitializers(declaration).flatMap((initializer) =>
        objectMemberTargets(context, initializer, memberName, new Set(seenSymbols)),
      ),
    ) ?? []
  );
}

function symbolTargets(
  context: CallableClosureContext,
  rawSymbol: ts.Symbol,
  seenSymbols: Set<ts.Symbol>,
): readonly CallableNode[] {
  const symbol = aliasedSymbol(context.checker, rawSymbol);
  if (seenSymbols.has(symbol)) return [];
  seenSymbols.add(symbol);
  const targets = (symbol.declarations ?? []).flatMap((declaration) => {
    if (isCallableNode(declaration)) return [declaration];
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
      return declaration.members.filter(
        (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && isCallableNode(member),
      );
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const valueSymbol = context.checker.getShorthandAssignmentValueSymbol(declaration);
      return valueSymbol === undefined ? [] : symbolTargets(context, valueSymbol, new Set(seenSymbols));
    }
    return expressionInitializers(declaration).flatMap((initializer) =>
      expressionTargets(context, initializer, new Set(seenSymbols)),
    );
  });
  return [...new Set(targets)];
}

function assignedExpressions(context: CallableClosureContext, rawSymbol: ts.Symbol): readonly ts.Expression[] {
  const symbol = aliasedSymbol(context.checker, rawSymbol);
  const assignments: ts.Expression[] = [];
  for (const declaration of symbol.declarations ?? []) {
    const sourceFile = declaration.getSourceFile();
    if (sourcePath(context, sourceFile) === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        symbolAtExpression(context, node.left) === rawSymbol
      ) {
        assignments.push(node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...new Set(assignments)];
}

function callableReturnExpressions(callable: CallableNode): readonly ts.Expression[] {
  if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) return [callable.body];
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== callable && isCallableNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) returns.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(callable);
  return returns;
}

function callableFactoryTargets(
  context: CallableClosureContext,
  call: ts.CallExpression,
  seenSymbols: Set<ts.Symbol>,
): readonly CallableNode[] {
  const rawFactorySymbol = symbolAtExpression(context, call.expression);
  const factorySymbol = rawFactorySymbol === undefined ? undefined : aliasedSymbol(context.checker, rawFactorySymbol);
  if (factorySymbol !== undefined && seenSymbols.has(factorySymbol)) return [];
  const nextSeenSymbols = new Set(seenSymbols);
  if (factorySymbol !== undefined) nextSeenSymbols.add(factorySymbol);
  const factoryTargets = executableTargets(context, call);
  return [
    ...new Set(
      factoryTargets.flatMap((factory) =>
        callableReturnExpressions(factory).flatMap((returned) =>
          expressionTargets(context, returned, new Set(nextSeenSymbols)),
        ),
      ),
    ),
  ];
}

function expressionTargets(
  context: CallableClosureContext,
  expression: ts.Expression,
  seenSymbols = new Set<ts.Symbol>(),
): readonly CallableNode[] {
  const unwrapped = unwrapExpression(expression);
  if (isCallableNode(unwrapped)) return [unwrapped];
  if (ts.isClassExpression(unwrapped)) {
    return unwrapped.members.filter(
      (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && isCallableNode(member),
    );
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return [
      ...expressionTargets(context, unwrapped.whenTrue, new Set(seenSymbols)),
      ...expressionTargets(context, unwrapped.whenFalse, new Set(seenSymbols)),
    ];
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return [
      ...expressionTargets(context, unwrapped.left, new Set(seenSymbols)),
      ...expressionTargets(context, unwrapped.right, new Set(seenSymbols)),
    ];
  }
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    unwrapped.expression.expression.getText() === 'Object' &&
    unwrapped.expression.name.text === 'freeze' &&
    unwrapped.arguments[0] !== undefined
  ) {
    return expressionTargets(context, unwrapped.arguments[0], seenSymbols);
  }
  if (ts.isCallExpression(unwrapped)) {
    return callableFactoryTargets(context, unwrapped, seenSymbols);
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const directSymbol = symbolAtExpression(context, unwrapped);
    const direct = directSymbol === undefined ? [] : symbolTargets(context, directSymbol, new Set(seenSymbols));
    const assigned =
      directSymbol === undefined
        ? []
        : assignedExpressions(context, directSymbol).flatMap((assignment) =>
            expressionTargets(context, assignment, new Set(seenSymbols)),
          );
    if (direct.length > 0 || assigned.length > 0) return [...new Set([...direct, ...assigned])];
    const memberName = ts.isPropertyAccessExpression(unwrapped)
      ? unwrapped.name.text
      : unwrapped.argumentExpression !== undefined && ts.isStringLiteralLike(unwrapped.argumentExpression)
        ? unwrapped.argumentExpression.text
        : undefined;
    return objectMemberTargets(context, unwrapped.expression, memberName, new Set(seenSymbols));
  }
  const symbol = symbolAtExpression(context, unwrapped);
  return symbol === undefined ? [] : symbolTargets(context, symbol, seenSymbols);
}

function projectDeclarations(context: CallableClosureContext, expression: ts.Expression): readonly ts.Declaration[] {
  const symbol = symbolAtExpression(context, expression);
  if (symbol === undefined) return [];
  return (aliasedSymbol(context.checker, symbol).declarations ?? []).filter(
    (declaration) => sourcePath(context, declaration.getSourceFile()) !== undefined,
  );
}

function isInjectedBoundaryDeclaration(declaration: ts.Declaration): boolean {
  return (
    ts.isParameter(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isCallSignatureDeclaration(declaration) ||
    ts.isFunctionTypeNode(declaration)
  );
}

function hasOnlyExternalDeclarations(context: CallableClosureContext, expression: ts.Expression): boolean {
  const symbol = symbolAtExpression(context, expression);
  if (symbol === undefined) return false;
  const declarations = aliasedSymbol(context.checker, symbol).declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => sourcePath(context, declaration.getSourceFile()) === undefined)
  );
}

function hasExternalRuntimeType(context: CallableClosureContext, expression: ts.Expression): boolean {
  const typeSymbol = context.checker.getTypeAtLocation(expression).getSymbol();
  const declarations = typeSymbol?.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => sourcePath(context, declaration.getSourceFile()) === undefined)
  );
}

function isRuntimeCallbackBoundary(context: CallableClosureContext, declaration: ts.Declaration): boolean {
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isForOfStatement(declaration.parent.parent)
  ) {
    const iterable = declaration.parent.parent.expression;
    const iterableDeclarations = projectDeclarations(context, iterable);
    return (
      hasOnlyExternalDeclarations(context, iterable) ||
      hasExternalRuntimeType(context, iterable) ||
      (iterableDeclarations.length > 0 && iterableDeclarations.every(isInjectedBoundaryDeclaration))
    );
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer === undefined
  ) {
    const declaredSymbol = context.checker.getSymbolAtLocation(declaration.name);
    if (declaredSymbol === undefined) return false;
    const assignments: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        context.checker.getSymbolAtLocation(node.left) === declaredSymbol
      ) {
        assignments.push(node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
    if (
      assignments.length > 0 &&
      assignments.every((assignment) => {
        const assignmentDeclarations = projectDeclarations(context, assignment);
        return assignmentDeclarations.length > 0 && assignmentDeclarations.every(isInjectedBoundaryDeclaration);
      })
    ) {
      return true;
    }
  }
  const initializers = expressionInitializers(declaration);
  return initializers.some((initializer) => {
    const unwrapped = unwrapExpression(initializer);
    if (ts.isCallExpression(unwrapped)) {
      const calleeDeclarations = projectDeclarations(context, unwrapped.expression);
      return (
        hasOnlyExternalDeclarations(context, unwrapped.expression) ||
        (calleeDeclarations.length > 0 && calleeDeclarations.every(isInjectedBoundaryDeclaration))
      );
    }
    const sourceDeclarations = projectDeclarations(context, unwrapped);
    return sourceDeclarations.length > 0 && sourceDeclarations.every(isInjectedBoundaryDeclaration);
  });
}

function unresolvedProjectCall(context: CallableClosureContext, expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (hasOnlyExternalDeclarations(context, unwrapped)) return false;
  const declarations = projectDeclarations(context, unwrapped);
  if (declarations.length > 0) {
    return !declarations.every(
      (declaration) => isInjectedBoundaryDeclaration(declaration) || isRuntimeCallbackBoundary(context, declaration),
    );
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return projectDeclarations(context, unwrapped.expression).some(
      (declaration) => !isInjectedBoundaryDeclaration(declaration),
    );
  }
  const rawSymbol = symbolAtExpression(context, unwrapped);
  return rawSymbol !== undefined && (rawSymbol.flags & ts.SymbolFlags.Alias) !== 0;
}

export function directCallableCalls(callable: CallableNode): readonly ExecutableCall[] {
  const calls: ExecutableCall[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== callable && isCallableNode(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(callable);
  return calls;
}

type CallableLeaf = Readonly<{
  node: ts.Node;
  expression: ts.Expression | undefined;
  symbol: ts.Symbol | undefined;
  targets: readonly CallableNode[];
}>;

function callableLeaves(
  context: CallableClosureContext,
  expression: ts.Expression,
  seenSymbols = new Set<ts.Symbol>(),
): readonly CallableLeaf[] {
  const unwrapped = unwrapExpression(expression);
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    unwrapped.expression.expression.getText() === 'Object' &&
    unwrapped.expression.name.text === 'freeze' &&
    unwrapped.arguments[0] !== undefined
  ) {
    return callableLeaves(context, unwrapped.arguments[0], seenSymbols);
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return [
      ...callableLeaves(context, unwrapped.whenTrue, new Set(seenSymbols)),
      ...callableLeaves(context, unwrapped.whenFalse, new Set(seenSymbols)),
    ];
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return [
      ...callableLeaves(context, unwrapped.left, new Set(seenSymbols)),
      ...callableLeaves(context, unwrapped.right, new Set(seenSymbols)),
    ];
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.flatMap((property) => {
      if (ts.isMethodDeclaration(property) && isCallableNode(property)) {
        return [{ node: property, expression: undefined, symbol: undefined, targets: [property] }];
      }
      if (ts.isPropertyAssignment(property)) {
        return callableLeaves(context, property.initializer, new Set(seenSymbols));
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = context.checker.getShorthandAssignmentValueSymbol(property);
        if (
          symbol === undefined ||
          context.checker.getTypeOfSymbolAtLocation(symbol, property).getCallSignatures().length === 0
        ) {
          return [];
        }
        return [
          {
            node: property,
            expression: undefined,
            symbol,
            targets: symbolTargets(context, symbol, new Set(seenSymbols)),
          },
        ];
      }
      if (ts.isSpreadAssignment(property)) {
        return callableLeaves(context, property.expression, new Set(seenSymbols));
      }
      return [];
    });
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap((element) =>
      ts.isSpreadElement(element)
        ? callableLeaves(context, element.expression, new Set(seenSymbols))
        : callableLeaves(context, element, new Set(seenSymbols)),
    );
  }
  const directSymbol = symbolAtExpression(context, unwrapped);
  const assignedLeaves =
    directSymbol === undefined
      ? []
      : assignedExpressions(context, directSymbol).flatMap((assignment) =>
          callableLeaves(context, assignment, new Set(seenSymbols)),
        );
  if (context.checker.getTypeAtLocation(unwrapped).getCallSignatures().length > 0) {
    return [
      ...assignedLeaves,
      {
        node: unwrapped,
        expression: unwrapped,
        symbol: undefined,
        targets: expressionTargets(context, unwrapped),
      },
    ];
  }
  const rawSymbol = symbolAtExpression(context, unwrapped);
  if (rawSymbol === undefined) return [];
  const symbol = aliasedSymbol(context.checker, rawSymbol);
  if (seenSymbols.has(symbol)) return [];
  seenSymbols.add(symbol);
  return [
    ...assignedLeaves,
    ...(symbol.declarations ?? []).flatMap((declaration) =>
      expressionInitializers(declaration).flatMap((initializer) => callableLeaves(context, initializer, seenSymbols)),
    ),
  ];
}

function callSite(sourceFile: ts.SourceFile, call: ExecutableCall): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  return `${line + 1}:${character + 1} ${call.expression.getText(sourceFile)}`;
}

type ClosureRoot = Readonly<{ callable: ResolvedCallable; label: string }>;

function isBodylessProjectConstruction(context: CallableClosureContext, call: ExecutableCall): boolean {
  return (
    ts.isNewExpression(call) &&
    projectDeclarations(context, call.expression).some(
      (declaration) =>
        (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
        !declaration.members.some((member) => ts.isConstructorDeclaration(member) && isCallableNode(member)),
    )
  );
}

function isInjectedOrExternalCallable(context: CallableClosureContext, expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (hasOnlyExternalDeclarations(context, unwrapped)) return true;
  const declarations = projectDeclarations(context, unwrapped);
  return declarations.length > 0 && declarations.every(isInjectedBoundaryDeclaration);
}

function isInjectedOrExternalCallableLeaf(context: CallableClosureContext, leaf: CallableLeaf): boolean {
  if (leaf.expression !== undefined) return isInjectedOrExternalCallable(context, leaf.expression);
  if (leaf.symbol === undefined) return false;
  const declarations = aliasedSymbol(context.checker, leaf.symbol).declarations ?? [];
  if (
    declarations.length > 0 &&
    declarations.every((declaration) => sourcePath(context, declaration.getSourceFile()) === undefined)
  ) {
    return true;
  }
  const project = declarations.filter((declaration) => sourcePath(context, declaration.getSourceFile()) !== undefined);
  return project.length > 0 && project.every(isInjectedBoundaryDeclaration);
}

function executableTargets(context: CallableClosureContext, call: ExecutableCall): readonly CallableNode[] {
  const signatureDeclaration = context.checker.getResolvedSignature(call)?.declaration;
  const signatureTarget =
    signatureDeclaration !== undefined && isCallableNode(signatureDeclaration) ? [signatureDeclaration] : [];
  return [...new Set([...expressionTargets(context, call.expression), ...signatureTarget])];
}

/**
 * Follow the checker-resolved `src/` closure from each semantic root. The guarded executable edges are ordinary
 * calls and `new` expressions, including explicit constructor bodies, imported aliases, concrete methods,
 * object/registry callback values, and every callable leaf in statically decomposable object, array, conditional,
 * and `Object.freeze` arguments. A callable leaf may remain unresolved only when that leaf is declared by an
 * injected parameter/signature or outside `src/`; a locally stored or selected leaf fails closed even when a
 * sibling leaf resolves. Direct calls through injected runtime callback boundaries and dependencies declared
 * outside `src/` remain outside the static scope. Any other unresolved project edge fails closed, and callers
 * assert non-vacuity over the resolved callable and edge sets.
 */
function analyzeRoots(context: CallableClosureContext, closureRoots: readonly ClosureRoot[]): CallableClosureAnalysis {
  const roots = closureRoots.map(({ callable }) => callable);
  const queue = closureRoots.map(({ callable, label }) => ({ callable, trace: [label] as readonly string[] }));
  const callables: CallableVisit[] = [];
  const edges: CallableEdge[] = [];
  const unresolvedCalls: string[] = [];
  const seen = new Set<CallableNode>();
  let inspectedCallCount = 0;

  while (queue.length > 0) {
    const current = queue.shift() as Readonly<{ callable: ResolvedCallable; trace: readonly string[] }>;
    if (seen.has(current.callable.node)) continue;
    seen.add(current.callable.node);
    callables.push({ ...current.callable, trace: current.trace });

    for (const call of directCallableCalls(current.callable.node)) {
      inspectedCallCount += 1;
      const site = `${current.callable.path}:${callSite(current.callable.sourceFile, call)}`;
      const calleeTargets = executableTargets(context, call)
        .map((node) => resolvedCallable(context, node))
        .filter((target): target is ResolvedCallable => target !== undefined);
      if (
        calleeTargets.length === 0 &&
        !isBodylessProjectConstruction(context, call) &&
        unresolvedProjectCall(context, call.expression)
      ) {
        unresolvedCalls.push(`${current.callable.path}#${current.callable.symbol} -> ${site} is unresolved`);
      }
      for (const target of calleeTargets) {
        edges.push({ from: current.callable, to: target, kind: 'call', site });
        queue.push({ callable: target, trace: [...current.trace, `${site} -> ${target.path}#${target.symbol}`] });
      }

      const callArguments = call.arguments ?? [];
      const callbackLeavesByArgument = callArguments.map((argument) =>
        callableLeaves(context, argument).map((leaf) => ({
          leaf,
          targets: leaf.targets
            .map((node) => resolvedCallable(context, node))
            .filter((target): target is ResolvedCallable => target !== undefined),
        })),
      );
      const callbacks = callbackLeavesByArgument.flatMap((leaves) => leaves.flatMap(({ targets }) => targets));
      for (const [argumentIndex, leaves] of callbackLeavesByArgument.entries()) {
        for (const { leaf, targets } of leaves) {
          if (targets.length > 0 || isInjectedOrExternalCallableLeaf(context, leaf)) continue;
          unresolvedCalls.push(
            `${current.callable.path}#${current.callable.symbol} -> ${site} argument ${argumentIndex + 1} '${leaf.node.getText(current.callable.sourceFile)}' has callable type but no resolvable target (unresolved callable leaf)`,
          );
        }
      }
      for (const target of callbacks) {
        edges.push({ from: current.callable, to: target, kind: 'callback', site });
        queue.push({ callable: target, trace: [...current.trace, `${site} => ${target.path}#${target.symbol}`] });
      }
    }
  }

  return {
    roots,
    callables,
    edges,
    inspectedCallCount,
    unresolvedCalls: [...new Set(unresolvedCalls)].sort(),
  };
}

function rootCallable(sourceFile: ts.SourceFile, symbol: string): CallableNode | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === symbol && isCallableNode(statement)) {
      return statement;
    }
    if (ts.isClassDeclaration(statement)) {
      const member = statement.members.find(
        (candidate) => isCallableNode(candidate) && callableSymbol(candidate, sourceFile) === symbol,
      );
      if (member !== undefined && isCallableNode(member)) return member;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === symbol &&
        declaration.initializer !== undefined &&
        isCallableNode(unwrapExpression(declaration.initializer))
      ) {
        return unwrapExpression(declaration.initializer) as CallableNode;
      }
    }
  }
  return undefined;
}

export function analyzeCallableClosure(
  context: CallableClosureContext,
  roots: readonly DecisionSymbol[],
): CallableClosureAnalysis {
  const missing: string[] = [];
  const resolvedRoots = roots.flatMap((root): ClosureRoot[] => {
    const sourceFile = context.sourceFilesByPath.get(root.path);
    const node = sourceFile === undefined ? undefined : rootCallable(sourceFile, root.symbol);
    if (sourceFile === undefined || node === undefined) {
      missing.push(`${root.path}#${root.symbol}`);
      return [];
    }
    const callable = resolvedCallable(context, node);
    if (callable === undefined) {
      missing.push(`${root.path}#${root.symbol}`);
      return [];
    }
    return [{ callable, label: `${root.path}#${root.symbol}` }];
  });
  if (missing.length > 0) throw new Error(`Unresolved callable closure roots: ${missing.join(', ')}`);
  return analyzeRoots(context, resolvedRoots);
}

export function analyzeCallableExpressionClosure(
  context: CallableClosureContext,
  roots: ReadonlyArray<Readonly<{ expression: ts.Expression; label: string }>>,
): CallableClosureAnalysis {
  const unresolved: string[] = [];
  const resolvedRoots = roots.flatMap(({ expression, label }): ClosureRoot[] => {
    const targets = expressionTargets(context, expression)
      .map((node) => resolvedCallable(context, node))
      .filter((target): target is ResolvedCallable => target !== undefined);
    if (targets.length === 0) unresolved.push(`${label} is unresolved`);
    return targets.map((callable) => ({ callable, label }));
  });
  const analysis = analyzeRoots(context, resolvedRoots);
  return { ...analysis, unresolvedCalls: [...unresolved, ...analysis.unresolvedCalls].sort() };
}

export function serviceabilityDecisionClosureAnalysis(
  repoRoot: string,
  productionFilePaths: readonly string[],
  suppliedContext?: CallableClosureContext,
): Readonly<Record<string, CallableClosureAnalysis>> {
  const context = suppliedContext ?? createCallableClosureContext(repoRoot, productionFilePaths);
  const roots = {
    ...STATIC_SERVICEABILITY_DECISION_SYMBOLS,
    providerClassifiers: providerClassifierFiles(repoRoot, productionFilePaths).flatMap(({ path, sourceFile }) =>
      exportedClassifierNames(sourceFile).map((symbol) => ({ path, symbol })),
    ),
  };
  return Object.fromEntries(
    Object.entries(roots).map(([category, decisions]) => {
      const analysis = analyzeCallableClosure(context, decisions);
      if (analysis.unresolvedCalls.length > 0) {
        throw new Error(
          `Unresolved project calls in ${category} serviceability closure:\n${analysis.unresolvedCalls.join('\n')}`,
        );
      }
      return [category, analysis];
    }),
  );
}

export function serviceabilityDecisionClosureInventory(
  repoRoot: string,
  productionFilePaths: readonly string[],
): Readonly<Record<string, readonly DecisionSymbol[]>> {
  return Object.fromEntries(
    Object.entries(serviceabilityDecisionClosureAnalysis(repoRoot, productionFilePaths)).map(([category, analysis]) => [
      category,
      analysis.callables.map(({ path, symbol }) => ({ path, symbol })),
    ]),
  );
}
