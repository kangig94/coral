import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POLICY_FILE = 'src/coordinator/services/provider-proxy-recovery-policy.ts';

function createProductionProgram(overlays: ReadonlyMap<string, string> = new Map()): ts.Program {
  const configPath = resolve(REPO_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT, undefined, configPath);
  const options = {
    ...parsed.options,
    composite: false,
    incremental: false,
    noEmit: true,
    tsBuildInfoFile: undefined,
  };
  const overlayFiles = new Map([...overlays].map(([path, source]) => [resolve(REPO_ROOT, path), source]));
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (fileName) => overlayFiles.get(fileName) ?? readFile(fileName);
  host.fileExists = (fileName) => overlayFiles.has(fileName) || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const overlay = overlayFiles.get(fileName);
    return overlay === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, overlay, languageVersion, true, ts.ScriptKind.TS);
  };
  return ts.createProgram({
    rootNames: [
      ...parsed.fileNames.filter((fileName) => fileName.startsWith(resolve(REPO_ROOT, 'src'))),
      ...overlayFiles.keys(),
    ],
    options,
    host,
  });
}

const PROGRAM = createProductionProgram();
const CHECKER = PROGRAM.getTypeChecker();
const SOURCE_FILES = PROGRAM.getSourceFiles().filter(
  (sourceFile) => !sourceFile.isDeclarationFile && sourceFile.fileName.startsWith(`${resolve(REPO_ROOT, 'src')}/`),
);

type ReferenceClass =
  | 'factory'
  | 'begin'
  | 'start'
  | 'producer'
  | 'sink'
  | 'effect'
  | 'fatal-sink'
  | 'facade'
  | 'raw-result'
  | 'fatal-origin';

type OwnedSymbol = Readonly<{
  key: string;
  referenceClass: ReferenceClass;
  symbol: ts.Symbol;
  declarations: ReadonlySet<ts.Declaration>;
}>;

function canonicalSymbol(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current !== undefined && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = CHECKER.getAliasedSymbol(current);
  }
  return current;
}

function sourceFile(path: string): ts.SourceFile {
  const found = PROGRAM.getSourceFile(resolve(REPO_ROOT, path));
  if (found === undefined) throw new Error(`Missing production source file '${path}'.`);
  return found;
}

function exportedSymbol(file: ts.SourceFile, name: string): ts.Symbol {
  const module = CHECKER.getSymbolAtLocation(file);
  const exported = module && CHECKER.getExportsOfModule(module).find((candidate) => candidate.name === name);
  const canonical = canonicalSymbol(exported);
  if (canonical === undefined) throw new Error(`Missing exported recovery-policy symbol '${name}'.`);
  return canonical;
}

function memberSymbol(owner: ts.Symbol, member: string): ts.Symbol {
  const found = CHECKER.getDeclaredTypeOfSymbol(owner).getProperty(member);
  const canonical = canonicalSymbol(found);
  if (canonical === undefined) throw new Error(`Missing recovery-policy member '${owner.name}.${member}'.`);
  return canonical;
}

function owned(key: string, referenceClass: ReferenceClass, symbol: ts.Symbol): OwnedSymbol {
  return {
    key,
    referenceClass,
    symbol,
    declarations: new Set(symbol.declarations ?? []),
  };
}

const policy = sourceFile(POLICY_FILE);
const dispatcher = exportedSymbol(policy, 'ProviderProxyRecoveryDispatcher');
const arbiter = exportedSymbol(policy, 'ProviderProxyRecoveryArbiter');
const producerPorts = exportedSymbol(policy, 'ProviderProxyRecoveryProducerPorts');
const turnSinks = exportedSymbol(policy, 'ProviderProxyRecoveryTurnSinks');
const effects = exportedSymbol(policy, 'ProviderProxyRecoveryEffects');
const fatalSink = exportedSymbol(policy, 'ProviderProxyRecoveryFatalSink');
const inheritance = sourceFile('src/coordinator/services/provider-proxy-set/inheritance.ts');
const disappearance = sourceFile('src/coordinator/services/provider-containment-disappearance.ts');
const representationAbandonment = sourceFile('src/coordinator/services/provider-representation-abandonment.ts');
const reconciler = sourceFile('src/coordinator/services/provider-operation-reconciler.ts');
const lifecycle = sourceFile('src/coordinator/services/provider-proxy-set/index.ts');
const disappearanceConsumer = exportedSymbol(disappearance, 'ProviderContainmentDisappearanceConsumer');
const representationAbandonmentConsumer = exportedSymbol(
  representationAbandonment,
  'ProviderRepresentationAbandonmentConsumer',
);
const reconcilerClass = exportedSymbol(reconciler, 'ProviderOperationReconciler');
const absenceAcceptance = exportedSymbol(lifecycle, 'ContainmentAbsenceAcceptance');
const producerIds = [
  'disappearance-terminalization',
  'role-control',
  'set-inheritance',
  'capsule-redemption',
  'containment-proof',
  'capsule-retirement',
  'disappearance-consumer',
  'representation-abandonment-consumer',
] as const;

const OWNED_SYMBOLS: readonly OwnedSymbol[] = [
  owned(
    'createProviderProxyRecoveryDispatcher',
    'factory',
    exportedSymbol(policy, 'createProviderProxyRecoveryDispatcher'),
  ),
  owned('ProviderProxyRecoveryDispatcher.begin', 'begin', memberSymbol(dispatcher, 'begin')),
  owned('ProviderProxyRecoveryArbiter.start', 'start', memberSymbol(arbiter, 'start')),
  ...producerIds.map((id) =>
    owned(`ProviderProxyRecoveryProducerPorts.${id}`, 'producer', memberSymbol(producerPorts, id)),
  ),
  ...(['evidence', 'retry', 'fatal'] as const).map((name) =>
    owned(`ProviderProxyRecoveryTurnSinks.${name}`, 'sink', memberSymbol(turnSinks, name)),
  ),
  ...(['retry', 'fatal'] as const).map((name) =>
    owned(`ProviderProxyRecoveryEffects.${name}`, 'effect', memberSymbol(effects, name)),
  ),
  owned('ProviderProxyRecoveryFatalSink.fatal', 'fatal-sink', memberSymbol(fatalSink, 'fatal')),
  owned('recoverProviderProxySetAtStartup', 'facade', exportedSymbol(inheritance, 'recoverProviderProxySetAtStartup')),
  owned(
    'recoverProviderProxySetOrdinarily',
    'facade',
    exportedSymbol(inheritance, 'recoverProviderProxySetOrdinarily'),
  ),
  owned(
    'ProviderContainmentDisappearanceConsumer.containmentDisappeared',
    'raw-result',
    memberSymbol(disappearanceConsumer, 'containmentDisappeared'),
  ),
  owned(
    'ProviderOperationReconciler.containmentDisappeared',
    'raw-result',
    memberSymbol(reconcilerClass, 'containmentDisappeared'),
  ),
  owned(
    'ProviderRepresentationAbandonmentConsumer.representationAbandoned',
    'raw-result',
    memberSymbol(representationAbandonmentConsumer, 'representationAbandoned'),
  ),
  owned(
    'ProviderOperationReconciler.representationAbandoned',
    'raw-result',
    memberSymbol(reconcilerClass, 'representationAbandoned'),
  ),
  owned(
    'ContainmentAbsenceAcceptance.initialDisposition',
    'raw-result',
    memberSymbol(absenceAcceptance, 'initialDisposition'),
  ),
  owned(
    'isProviderProxyRecoveryFatalError',
    'fatal-origin',
    exportedSymbol(policy, 'isProviderProxyRecoveryFatalError'),
  ),
];

/**
 * PARTIAL ENFORCEMENT — DO NOT TREAT THIS INVARIANT AS A PROVENANCE GUARANTEE.
 *
 * TypeScript is structurally typed. This check deliberately does not perform the taint analysis needed to
 * follow an exact dispatcher through assignment, arguments, returns, or object storage into a locally declared
 * compatible interface; calls then resolve to the local begin/start/sink declarations. It also does not follow
 * a dynamic import through two `export *` barrels into a structurally annotated callback, or recover an owned
 * member carried solely by a contextual type when destructured function parameters have no initializer. These
 * escape forms compile without casts, `any`, or reflection. This test catches only the exact-symbol paths
 * inventoried below.
 */

function matchOwnedSymbol(symbol: ts.Symbol | undefined): OwnedSymbol | undefined {
  const canonical = canonicalSymbol(symbol);
  if (canonical === undefined) return undefined;
  return OWNED_SYMBOLS.find(
    (candidate) =>
      candidate.symbol === canonical ||
      (canonical.declarations?.some((declaration) => candidate.declarations.has(declaration)) ?? false),
  );
}

function relativePath(file: ts.SourceFile): string {
  return relative(REPO_ROOT, file.fileName).replaceAll('\\', '/');
}

function declarationName(node: ts.Node): boolean {
  return 'name' in node.parent && (node.parent as ts.NamedDeclaration).name === node;
}

function typeOnly(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isImportClause(current)) return current.isTypeOnly;
    if (ts.isImportSpecifier(current)) {
      return current.isTypeOnly || (ts.isImportClause(current.parent.parent) && current.parent.parent.isTypeOnly);
    }
    if (ts.isExportSpecifier(current)) return current.isTypeOnly;
    if (ts.isStatement(current) || ts.isExpression(current)) return false;
  }
  return false;
}

function namedOwner(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current)) &&
      current.name !== undefined
    ) {
      return current;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current;
    }
  }
  return undefined;
}

function ownerName(owner: ts.FunctionLikeDeclaration | undefined): string {
  if (owner === undefined) return '<module>';
  if ('name' in owner && owner.name !== undefined) return owner.name.getText();
  if (ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) return owner.parent.name.text;
  return '<anonymous>';
}

type Reference = Readonly<{
  file: string;
  owner: string;
  nodeKind: string;
  target: OwnedSymbol;
  node: ts.Node;
}>;

function resolvedCallSymbol(call: ts.CallExpression): ts.Symbol | undefined {
  const direct = CHECKER.getSymbolAtLocation(call.expression);
  if (direct !== undefined) return direct;
  const declaration = CHECKER.getResolvedSignature(call)?.declaration;
  return declaration !== undefined && 'name' in declaration && declaration.name !== undefined
    ? CHECKER.getSymbolAtLocation(declaration.name)
    : undefined;
}

type PromiseRejectionKind = 'Promise.catch' | 'Promise.then(rejected)' | 'Promise.allSettled';

function standardPromiseRejectionKind(call: ts.CallExpression): PromiseRejectionKind | null {
  if (!ts.isPropertyAccessExpression(call.expression) && !ts.isElementAccessExpression(call.expression)) {
    return null;
  }
  const access = call.expression;
  const property = ts.isPropertyAccessExpression(access)
    ? access.name
    : access.argumentExpression !== undefined &&
        (ts.isStringLiteral(access.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(access.argumentExpression))
      ? access.argumentExpression
      : undefined;
  if (property === undefined) return null;
  if (!['catch', 'then', 'allSettled'].includes(property.text)) return null;
  const symbol = canonicalSymbol(CHECKER.getSymbolAtLocation(property));
  if (
    symbol === undefined ||
    symbol.declarations?.some((declaration) => {
      const source = declaration.getSourceFile();
      return source.isDeclarationFile && /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(source.fileName);
    }) !== true
  ) {
    return null;
  }
  if (symbol.name === 'catch' && call.arguments.length > 0) return 'Promise.catch';
  if (symbol.name === 'then' && call.arguments.length > 1) return 'Promise.then(rejected)';
  if (symbol.name === 'allSettled') return 'Promise.allSettled';
  return null;
}

function bindingElementSymbol(node: ts.BindingElement): ts.Symbol | undefined {
  const chain: ts.BindingElement[] = [node];
  let pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern = node.parent;
  while (ts.isBindingElement(pattern.parent)) {
    chain.unshift(pattern.parent);
    pattern = pattern.parent.parent;
  }
  if (!ts.isVariableDeclaration(pattern.parent) || pattern.parent.initializer === undefined) return undefined;
  let currentType = CHECKER.getTypeAtLocation(pattern.parent.initializer);
  for (const element of chain) {
    if (!ts.isObjectBindingPattern(element.parent)) return undefined;
    const property = element.propertyName ?? element.name;
    if (!ts.isIdentifier(property) && !ts.isStringLiteral(property) && !ts.isNumericLiteral(property)) {
      return undefined;
    }
    const symbol = canonicalSymbol(currentType.getProperty(property.text));
    if (symbol === undefined) return undefined;
    if (element === node) return symbol;
    currentType = CHECKER.getTypeOfSymbolAtLocation(symbol, element);
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isExactCallCallee(node: ts.Node): boolean {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent;
  }
  return ts.isCallExpression(current.parent) && unwrapExpression(current.parent.expression) === node;
}

type ReferenceRecorder = (file: ts.SourceFile, node: ts.Node, symbol: ts.Symbol | undefined, nodeKind: string) => void;

function recordContextualProperties(file: ts.SourceFile, node: ts.ObjectLiteralExpression, record: ReferenceRecorder) {
  const contextual = CHECKER.getContextualType(node);
  if (contextual === undefined) return;
  for (const property of node.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isMethodDeclaration(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const name = property.name;
    if (name === undefined) continue;
    const memberName = name.getText(file).replaceAll(/["']/gu, '');
    record(file, property, contextual.getProperty(memberName), `Contextual${ts.SyntaxKind[property.kind]}`);
  }
}

function recordSyntaxReference(file: ts.SourceFile, node: ts.Node, record: ReferenceRecorder): void {
  if (ts.isBindingElement(node)) {
    record(file, node, bindingElementSymbol(node), 'BindingElement');
  } else if (ts.isImportSpecifier(node)) {
    record(file, node, CHECKER.getSymbolAtLocation(node.name), 'ImportSpecifier');
  } else if (ts.isExportSpecifier(node)) {
    record(file, node, CHECKER.getSymbolAtLocation(node.name), 'ExportSpecifier');
  } else if (ts.isCallExpression(node)) {
    record(file, node, resolvedCallSymbol(node), 'CallExpression');
  } else if (ts.isPropertyAccessExpression(node)) {
    record(file, node, CHECKER.getSymbolAtLocation(node.name), 'PropertyAccessExpression');
  } else if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    record(file, node, CHECKER.getSymbolAtLocation(node.argumentExpression), 'ElementAccessExpression');
  } else if (
    ts.isIdentifier(node) &&
    !declarationName(node) &&
    !typeOnly(node) &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  ) {
    record(file, node, CHECKER.getSymbolAtLocation(node), 'Identifier');
  } else if (ts.isShorthandPropertyAssignment(node)) {
    record(file, node, CHECKER.getShorthandAssignmentValueSymbol(node), 'ShorthandPropertyAssignment');
  }
}

function collectSourceFileReferences(file: ts.SourceFile, record: ReferenceRecorder): void {
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) recordContextualProperties(file, node, record);
    recordSyntaxReference(file, node, record);
    ts.forEachChild(node, visit);
  };
  visit(file);
}

function collectReferences(): Reference[] {
  const references: Reference[] = [];
  const seen = new Set<string>();
  const record: ReferenceRecorder = (file, node, symbol, nodeKind) => {
    const target = matchOwnedSymbol(symbol);
    if (target === undefined) return;
    const key = `${file.fileName}:${node.getStart(file)}:${node.getEnd()}:${target.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ file: relativePath(file), owner: ownerName(namedOwner(node)), nodeKind, target, node });
  };
  for (const file of SOURCE_FILES) collectSourceFileReferences(file, record);
  return references;
}

const DIRECT_CALL_ONLY_CLASSES = new Set<ReferenceClass>([
  'begin',
  'start',
  'facade',
  'producer',
  'sink',
  'effect',
  'fatal-sink',
  'raw-result',
  'fatal-origin',
]);

function initialDispositionRole(reference: Reference): string | null {
  if (reference.target.key !== 'ContainmentAbsenceAcceptance.initialDisposition') return null;
  if (reference.nodeKind.startsWith('Contextual')) return 'lifecycle-public-disposition-property';
  if (!ts.isPropertyAccessExpression(reference.node)) return null;
  const call = reference.node.parent;
  const callee = ts.isCallExpression(call) ? canonicalSymbol(resolvedCallSymbol(call)) : undefined;
  const isAwaitStartupArgument =
    ts.isCallExpression(call) &&
    call.arguments[0] === reference.node &&
    callee?.name === 'awaitStartup' &&
    callee.declarations?.some(
      (declaration) =>
        relativePath(declaration.getSourceFile()) === 'src/coordinator/services/provider-operation-reconciler.ts',
    ) === true;
  if (isAwaitStartupArgument) return 'awaitStartup-argument-zero';
  const owner = namedOwner(reference.node);
  const isOperatorExitStateGatedRead =
    ownerName(owner) === 'operatorExitClaimDischarge' &&
    owner !== undefined &&
    relativePath(owner.getSourceFile()) === 'src/coordinator/services/provider-proxy-set/index.ts';
  return isOperatorExitStateGatedRead ? 'operator-exit-state-gated-read' : 'unregistered-result-role';
}

function valueEscapeViolations(references: readonly Reference[]): string[] {
  return references
    .filter((reference) => {
      if (!DIRECT_CALL_ONLY_CLASSES.has(reference.target.referenceClass)) return false;
      if (ts.isCallExpression(reference.node)) return false;
      if (reference.nodeKind.startsWith('Contextual')) return false;
      if (ts.isImportSpecifier(reference.node)) return false;
      if (
        ['awaitStartup-argument-zero', 'operator-exit-state-gated-read'].includes(
          initialDispositionRole(reference) ?? '',
        )
      ) {
        return false;
      }
      return !isExactCallCallee(reference.node);
    })
    .map(
      (reference) =>
        `${reference.file} :: ${reference.owner} :: ${reference.nodeKind} value escape for ${reference.target.key}`,
    )
    .sort();
}

function stringLiteralArgument(call: ts.CallExpression, index: number): string | null {
  const argument = call.arguments[index];
  return argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : null;
}

function stringObjectProperty(expression: ts.Expression | undefined, name: string): string | null {
  if (expression === undefined || !ts.isObjectLiteralExpression(expression)) return null;
  const property = expression.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText().replaceAll(/["']/gu, '') === name,
  );
  if (property === undefined) return null;
  return ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)
    ? property.initializer.text
    : null;
}

function callsFor(targetKey: string, references: readonly Reference[]): Reference[] {
  return references.filter((reference) => reference.target.key === targetKey && ts.isCallExpression(reference.node));
}

function rejectionFingerprint(
  owner: ts.FunctionLikeDeclaration | undefined,
  catchClause: ts.CatchClause,
  ordinal: number,
): string {
  const calls: string[] = [];
  const assignments: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText());
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      assignments.push(node.left.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(catchClause.block);
  return `${relativePath(catchClause.getSourceFile())} :: ${ownerName(owner)} :: catch#${ordinal} :: calls=[${calls.join(
    ', ',
  )}] assignments=[${assignments.join(', ')}]`;
}

function rejectionConsumerOwners(references: readonly Reference[]): Set<ts.FunctionLikeDeclaration> {
  const owners = new Set<ts.FunctionLikeDeclaration>();
  for (const reference of references) {
    if (reference.file === POLICY_FILE) continue;
    const owner = namedOwner(reference.node);
    if (owner !== undefined) owners.add(owner);
  }
  return owners;
}

function consumedSymbolsForOwner(owner: ts.FunctionLikeDeclaration, references: readonly Reference[]): string[] {
  return references
    .filter((reference) => namedOwner(reference.node) === owner)
    .map((reference) => reference.target.key)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

function returnedShapes(node: ts.Node): string[] {
  const shapes: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isReturnStatement(child) && child.expression !== undefined) {
      shapes.push(child.expression.getText().replaceAll(/\s+/gu, ' '));
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return shapes;
}

function catchRejectionViolation(
  owner: ts.FunctionLikeDeclaration,
  catchClause: ts.CatchClause,
  ordinal: number,
  consumedSymbols: readonly string[],
): string | null {
  const fingerprint = rejectionFingerprint(owner, catchClause, ordinal);
  if (EXPECTED_REJECTION_NODE_INVENTORY.includes(fingerprint as never)) return null;
  return `${fingerprint} consumed=[${consumedSymbols.join(', ')}] returned=[${returnedShapes(catchClause.block).join(
    ', ',
  )}]`;
}

function promiseRejectionViolation(
  owner: ts.FunctionLikeDeclaration,
  call: ts.CallExpression,
  consumedSymbols: readonly string[],
): string | null {
  const kind = standardPromiseRejectionKind(call);
  if (kind === null) return null;
  const fingerprint = `${relativePath(owner.getSourceFile())} :: ${ownerName(owner)} :: ${kind} :: ${call.expression
    .getText()
    .replaceAll(/\s+/gu, ' ')}`;
  return EXPECTED_REJECTION_NODE_INVENTORY.includes(fingerprint as never)
    ? null
    : `${fingerprint} consumed=[${consumedSymbols.join(', ')}]`;
}

function rejectionViolationsForOwner(owner: ts.FunctionLikeDeclaration, references: readonly Reference[]): string[] {
  const violations: string[] = [];
  const consumedSymbols = consumedSymbolsForOwner(owner, references);
  let catchOrdinal = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      catchOrdinal += 1;
      const violation = catchRejectionViolation(owner, node, catchOrdinal, consumedSymbols);
      if (violation !== null) violations.push(violation);
    }
    if (ts.isCallExpression(node)) {
      const violation = promiseRejectionViolation(owner, node, consumedSymbols);
      if (violation !== null) violations.push(violation);
    }
    ts.forEachChild(node, visit);
  };
  if (owner.body !== undefined) visit(owner.body);
  return violations;
}

function consumerRejectionViolations(references: readonly Reference[]): string[] {
  return [...rejectionConsumerOwners(references)].flatMap((owner) => rejectionViolationsForOwner(owner, references));
}

function rejectionNodeInventory(references: readonly Reference[]): string[] {
  const inventory: string[] = [];
  const catchOrdinals = new Map<string, number>();
  // Union, not replacement: graph references pull in a file this inventory has never named, while the
  // pinned fingerprints keep a file that stopped referencing a tracked symbol from leaving the scan
  // unnoticed. Either source alone lets a rejection consumer go unwatched.
  const rejectionFiles = new Set([
    POLICY_FILE,
    ...references.map((reference) => reference.file),
    ...EXPECTED_REJECTION_NODE_INVENTORY.map((fingerprint) => fingerprint.slice(0, fingerprint.indexOf(' :: '))),
  ]);
  for (const file of SOURCE_FILES) {
    const path = relativePath(file);
    if (!rejectionFiles.has(path)) continue;
    const visit = (node: ts.Node): void => {
      const owner = namedOwner(node);
      const name = ownerName(owner);
      if (ts.isCatchClause(node)) {
        const ordinalKey = `${path}:${name}`;
        const ordinal = (catchOrdinals.get(ordinalKey) ?? 0) + 1;
        catchOrdinals.set(ordinalKey, ordinal);
        inventory.push(rejectionFingerprint(owner, node, ordinal));
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const kind = standardPromiseRejectionKind(node);
        if (kind !== null) {
          inventory.push(`${path} :: ${name} :: ${kind} :: ${callee.getText().replaceAll(/\s+/gu, ' ')}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return inventory.sort();
}

const EXPECTED_REJECTION_NODE_INVENTORY = [
  'src/coordinator/live/provider-proxy/role-control.ts :: establishRoleControl :: catch#1 :: calls=[classifyRoleControlFailure] assignments=[]',
  'src/coordinator/live/provider-proxy/role-control.ts :: establishRoleControl :: catch#2 :: calls=[classifyRoleControlFailure] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #attemptExecutingAttachment :: catch#1 :: calls=[readProviderOperation, this.#deps.getProgressStore().getDb, this.#deps.getProgressStore, this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #awaitAuthority :: Promise.then(rejected) :: pending.then',
  'src/coordinator/services/provider-operation-reconciler.ts :: #awaitAuthority :: catch#1 :: calls=[reject, errorMessage] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveActivationResolution :: catch#1 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveActivationResolution :: catch#2 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveActivationResolution :: catch#3 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveActivationResolution :: catch#4 :: calls=[readProviderOperation, this.#deps.getProgressStore().getDb, this.#deps.getProgressStore, this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveGuardianActivation :: catch#1 :: calls=[providerOperationErrorIsAmbiguous, this.#recordRetry, this.#transition, this.#prestartCleanupRecord, this.#deps.time.now, providerOperationErrorCode, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveLocalRecovery :: catch#1 :: calls=[readProviderOperation, this.#deps.getProgressStore().getDb, this.#deps.getProgressStore, this.#complete, this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveLocalRecovery :: catch#2 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveLocalRecovery :: catch#3 :: calls=[readProviderOperation, this.#deps.getProgressStore().getDb, this.#deps.getProgressStore, this.#deps.completeLocalRecovery, this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #drivePrepare :: catch#1 :: calls=[providerOperationErrorIsAmbiguous, this.#transition, this.#prepareRefusalRecord, providerOperationPreparePermanentRefusalSchema.parse, boundedPrepareRefusalReason, this.#awaitAuthority, authority.inspectOperation, this.#acceptPreparedEvidence, this.#acceptPrepareResult, this.#recoverPrepare, this.#recordRetry, providerOperationErrorReason, this.#recordRetry, providerOperationErrorReason, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #drivePrepare :: catch#2 :: calls=[this.#recordRetry, providerOperationErrorReason, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #drivePrepare :: catch#3 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #drivePrestartCleanup :: catch#1 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveProxyActivation :: catch#1 :: calls=[providerOperationErrorIsAmbiguous, this.#recordRetry, this.#transition, this.#activationResolutionRecord, this.#deps.time.now, providerOperationErrorCode, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveProxyActivation :: catch#2 :: calls=[readProviderOperation, this.#deps.getProgressStore().getDb, this.#deps.getProgressStore, this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #driveSettlement :: catch#1 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #poll :: catch#1 :: calls=[this.#latchFatal, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #poll :: catch#2 :: calls=[this.#observeFatal, this.#deps.onError, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #reconcileDueSelection :: catch#1 :: calls=[] assignments=[driveError]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #reconcileDueSelection :: catch#2 :: calls=[this.#latchFatal, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #recoverPrepare :: catch#1 :: calls=[providerOperationErrorIsAmbiguous, this.#transition, this.#prepareRefusalRecord, providerOperationPreparePermanentRefusalSchema.parse, boundedPrepareRefusalReason, this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: #recoverPrepare :: catch#2 :: calls=[this.#recordRetry] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: awaitStartup :: Promise.then(rejected) :: operation.then',
  'src/coordinator/services/provider-operation-reconciler.ts :: begin :: catch#1 :: calls=[this.#failPublication, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-operation-reconciler.ts :: containmentDisappeared :: Promise.then(rejected) :: active.then',
  'src/coordinator/services/provider-operation-reconciler.ts :: containmentDisappeared :: Promise.then(rejected) :: promise.then',
  'src/coordinator/services/provider-operation-reconciler.ts :: onControlEstablished :: Promise.catch :: this.#reconcileActiveForAuthority(authority).catch',
  'src/coordinator/services/provider-operation-reconciler.ts :: reconcile :: Promise.catch :: this.#driveContext .run(context, () => this.#drive(record, preferredAuthority, context.signal)) .catch',
  'src/coordinator/services/provider-operation-reconciler.ts :: representationAbandoned :: Promise.then(rejected) :: active.then',
  'src/coordinator/services/provider-operation-reconciler.ts :: representationAbandoned :: Promise.then(rejected) :: promise.then',
  'src/coordinator/services/provider-operation-reconciler.ts :: requestStop :: catch#1 :: calls=[this.#deps.onError, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-proxy-recovery-policy.ts :: errorCode :: catch#1 :: calls=[] assignments=[]',
  'src/coordinator/services/provider-proxy-recovery-policy.ts :: runProviderProxyRecoveryDeadline :: catch#1 :: calls=[] assignments=[]',
  'src/coordinator/services/provider-proxy-recovery-policy.ts :: start :: Promise.then(rejected) :: Promise.resolve(produced).then',
  'src/coordinator/services/provider-proxy-recovery-policy.ts :: start :: catch#1 :: calls=[submit, classifyRejection] assignments=[]',
  'src/coordinator/services/provider-proxy-set/index.ts :: #beginContainment :: Promise.catch :: slot.authority.initiateControlClose().catch',
  'src/coordinator/services/provider-proxy-set/index.ts :: #promoteControlReattachment :: Promise.catch :: oldAuthority.initiateControlClose().catch',
  'src/coordinator/services/provider-proxy-set/index.ts :: #promoteControlReattachment :: Promise.catch :: promoted.initiateControlClose().catch',
  'src/coordinator/services/provider-proxy-set/index.ts :: #promoteControlReattachment :: catch#1 :: calls=[this.#isCurrentControlReattachment, this.#deps.onError, singleLineErrorSummary, this.#scheduleControlReattachmentRetry] assignments=[window.attemptAbort]',
  'src/coordinator/services/provider-proxy-set/index.ts :: #recoverExactCapsule :: Promise.then(rejected) :: this.#reapRecordedContainment(evidence, reapAbort.signal, () => undefined).then',
  'src/coordinator/services/provider-proxy-set/index.ts :: #report :: catch#1 :: calls=[] assignments=[]',
  'src/coordinator/services/provider-proxy-set/index.ts :: #runContainmentAttempt :: Promise.then(rejected) :: this.#reapRecordedContainment(evidence, abort.signal, () => undefined).then',
  'src/coordinator/services/provider-proxy-set/index.ts :: #runControlReattachmentAttempt :: Promise.then(rejected) :: this.#reapRecordedContainment(evidence, reapAbort.signal, () => undefined).then',
  'src/coordinator/services/provider-proxy-set/index.ts :: completeOperatorExit :: Promise.catch :: slot.authority.initiateControlClose().catch',
  'src/coordinator/services/provider-proxy-set/index.ts :: completeOperatorExit :: Promise.catch :: slot.authority.initiateControlClose().catch',
  'src/coordinator/services/provider-proxy-set/index.ts :: completeOperatorExit :: catch#1 :: calls=[this.#slots.get, providerProxySetKey] assignments=[]',
  'src/coordinator/services/provider-proxy-set/index.ts :: containmentAbsent :: Promise.catch :: authorityToClose .initiateControlClose() .catch',
  'src/coordinator/services/provider-proxy-set/index.ts :: createInitialDispositionLatch :: Promise.catch :: promise.catch',
  'src/coordinator/services/provider-proxy-set/inheritance.ts :: attemptProviderProxySetInheritance :: catch#1 :: calls=[deps.collectContainmentEvidence, deps.reapRecordedContainment] assignments=[]',
  'src/coordinator/services/provider-proxy-set/inheritance.ts :: attemptProviderProxySetInheritance :: catch#2 :: calls=[] assignments=[]',
  'src/coordinator/services/provider-proxy-set/inheritance.ts :: buildInheritedAuthority :: catch#1 :: calls=[closeRedeemedProviderProxyControl] assignments=[]',
  'src/jobs/provider-operation-terminalization.ts :: readProviderHostUnserviceableEvidence :: catch#1 :: calls=[] assignments=[]',
  'src/jobs/provider-operation-terminalization.ts :: terminalizeProviderOperation :: catch#1 :: calls=[] assignments=[]',
] as const;

function rejectionJustification(fingerprint: string): string {
  if (fingerprint.startsWith('src/coordinator/live/provider-proxy/role-control.ts')) {
    return 'Producer-side role-control classifier preserves typed transport and remote-response causes.';
  }
  if (fingerprint.includes(' :: #poll :: ') || fingerprint.includes(' :: #reconcileDueSelection :: ')) {
    return 'Due-page wrapper captures drive/repair failure and preserves fatal observation before warning.';
  }
  if (fingerprint.startsWith('src/coordinator/services/provider-operation-reconciler.ts')) {
    return 'Existing phase-specific serialization or publication boundary preserves the r17 disposition contract.';
  }
  if (fingerprint.startsWith(POLICY_FILE)) {
    return 'The central dispatcher alone classifies producer rejection and deadline cancellation.';
  }
  if (fingerprint.startsWith('src/coordinator/services/provider-proxy-set/inheritance.ts')) {
    return 'Producer-side inheritance protocol cleanup preserves causal evidence without consuming a dispatcher façade.';
  }
  if (fingerprint.includes(' :: #beginContainment :: ')) {
    return fingerprint.includes('Promise.then(rejected)')
      ? 'Lifecycle retains the current containment attempt after its sanctioned exact-set reaper rejects.'
      : 'A best-effort close cannot revoke a containment the lifecycle has already entered.';
  }
  if (fingerprint.includes(' :: #promoteControlReattachment :: ')) {
    return 'Failed promotion keeps the original hold and displaced-control close failure cannot revoke the promoted authority.';
  }
  if (fingerprint.includes(' :: containmentAbsent :: ')) {
    return 'Authority-close observation cannot settle or relabel disappearance delivery.';
  }
  if (fingerprint.includes(' :: createInitialDispositionLatch :: ')) {
    return 'No-op observer prevents an unhandled rejection while returning the original promise unchanged.';
  }
  if (fingerprint.includes(' :: #report :: ')) {
    return 'Lifecycle observability failure cannot interrupt an authority transition.';
  }
  if (fingerprint.includes(' :: #recoverExactCapsule :: ')) {
    return 'Lifecycle retains and retries exact-capsule recovery after its sanctioned exact-set reaper rejects.';
  }
  if (fingerprint.includes(' :: #runControlReattachmentAttempt :: ')) {
    return 'Lifecycle retains the reattachment hold and schedules its bounded retry after exact-set reaping rejects.';
  }
  if (fingerprint.includes(' :: completeOperatorExit :: ')) {
    return fingerprint.includes('catch#1')
      ? 'Lifecycle converts a moved attempt after signalling into an honest partial authorization-stale outcome.'
      : 'A best-effort control close cannot revoke accepted operator abandonment or relabel its process observation.';
  }
  if (fingerprint.includes(' :: readProviderHostUnserviceableEvidence :: ')) {
    return 'Malformed provider-host evidence cannot authorize terminalization.';
  }
  return 'Atomic terminalization producer boundary preserves its narrow retry-safety proof.';
}

const REJECTION_AUTHORIZATIONS = EXPECTED_REJECTION_NODE_INVENTORY.map((fingerprint) => ({
  fingerprint,
  justification: rejectionJustification(fingerprint),
}));

type JustifiedOccurrence = Readonly<{ occurrence: string; justification: string }>;

const BOUNDARY_AUTHORIZATIONS: readonly JustifiedOccurrence[] = [
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: <module> :: ImportSpecifier :: createProviderProxyRecoveryDispatcher',
    justification: 'Composition is the sole production dispatcher factory importer.',
  },
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: <module> :: ImportSpecifier :: recoverProviderProxySetAtStartup',
    justification: 'Composition owns the sole startup inheritance façade import.',
  },
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: <module> :: ImportSpecifier :: recoverProviderProxySetOrdinarily',
    justification: 'Composition owns the sole ordinary inheritance façade import.',
  },
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: createExecutionServices :: CallExpression :: createProviderProxyRecoveryDispatcher',
    justification: 'Composition creates the single production recovery dispatcher.',
  },
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: createExecutionServices :: CallExpression :: recoverProviderProxySetAtStartup :: awaited-outcome-initializer',
    justification: 'The startup recovery producer awaits the registered startup façade.',
  },
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: createExecutionServices :: CallExpression :: recoverProviderProxySetOrdinarily :: awaited-outcome-initializer',
    justification: 'The ordinary authority acquisition path awaits the registered ordinary façade.',
  },
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: createExecutionServices :: CallExpression :: ProviderOperationReconciler.containmentDisappeared',
    justification: 'The disappearance-consumer producer closes over the concrete reconciler method.',
  },
  {
    occurrence:
      'src/coordinator/composition/execution-services.ts :: createExecutionServices :: CallExpression :: ProviderOperationReconciler.representationAbandoned',
    justification: 'The abandonment-consumer producer closes over the distinct concrete reconciler method.',
  },
  {
    occurrence:
      'src/coordinator/services/provider-operation-reconciler.ts :: <module> :: ImportSpecifier :: isProviderProxyRecoveryFatalError',
    justification: 'The reconciler imports the origin guard to seal already-published fatal evidence.',
  },
  {
    occurrence:
      'src/coordinator/services/provider-operation-reconciler.ts :: #observeFatal :: CallExpression :: isProviderProxyRecoveryFatalError',
    justification: 'The single observation helper recognizes dispatcher-issued fatal evidence without republishing it.',
  },
  {
    occurrence:
      'src/coordinator/services/provider-operation-reconciler.ts :: #reconcileStartupSet :: PropertyAccessExpression :: ContainmentAbsenceAcceptance.initialDisposition :: awaitStartup-argument-zero',
    justification: 'Startup awaits the original lifecycle disposition promise through the identity-preserving helper.',
  },
  {
    occurrence:
      'src/coordinator/services/provider-proxy-set/index.ts :: operatorExitClaimDischarge :: PropertyAccessExpression :: ContainmentAbsenceAcceptance.initialDisposition :: operator-exit-state-gated-read',
    justification:
      'Operator exit reads through the latch-state gate, which reports pending ownership and awaits only an already-settled disposition.',
  },
  {
    occurrence:
      'src/coordinator/services/provider-proxy-recovery-policy.ts :: classifyRejection :: CallExpression :: isProviderProxyRecoveryFatalError',
    justification: 'The dispatcher recognizes forwarded fatal evidence before any causal reclassification.',
  },
  {
    occurrence:
      'src/coordinator/services/provider-proxy-set/index.ts :: #absenceAcceptance :: ContextualPropertyAssignment :: ContainmentAbsenceAcceptance.initialDisposition :: lifecycle-public-disposition-property',
    justification: 'Lifecycle constructs the one public disposition boundary from its unchanged latch promise.',
  },
];

function boundaryInventory(references: readonly Reference[]): string[] {
  return references
    .filter((reference) => {
      if (!['factory', 'facade', 'raw-result', 'fatal-origin'].includes(reference.target.referenceClass)) return false;
      if (ts.isImportSpecifier(reference.node) || ts.isCallExpression(reference.node)) return true;
      if (reference.target.referenceClass !== 'raw-result') return false;
      if (initialDispositionRole(reference) !== null) return true;
      return !isExactCallCallee(reference.node);
    })
    .map((reference) => {
      const occurrence = `${reference.file} :: ${reference.owner} :: ${reference.nodeKind} :: ${reference.target.key}`;
      if (reference.target.referenceClass === 'facade' && ts.isCallExpression(reference.node)) {
        const awaited = ts.isAwaitExpression(reference.node.parent) ? reference.node.parent : null;
        const declaration = awaited?.parent;
        const role =
          declaration !== undefined &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer === awaited &&
          ts.isIdentifier(declaration.name)
            ? `awaited-${declaration.name.text}-initializer`
            : 'unregistered-facade-call-role';
        return `${occurrence} :: ${role}`;
      }
      const role = initialDispositionRole(reference);
      if (role !== null) return `${occurrence} :: ${role}`;
      return occurrence;
    })
    .sort();
}

type AdversarialAnalysis = Readonly<{
  bindingEscapes: readonly string[];
  valueEscapes: readonly string[];
  ownedOccurrences: readonly string[];
  rejections: readonly string[];
}>;

function analyzeAdversarialProgram(program: ts.Program, path: string): AdversarialAnalysis {
  const checker = program.getTypeChecker();
  const canonical = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    while (current !== undefined && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
      seen.add(current);
      current = checker.getAliasedSymbol(current);
    }
    return current;
  };
  const fileAt = (filePath: string): ts.SourceFile => {
    const file = program.getSourceFile(resolve(REPO_ROOT, filePath));
    if (file === undefined) throw new Error(`Missing adversarial program source '${filePath}'.`);
    return file;
  };
  const exported = (file: ts.SourceFile, name: string): ts.Symbol => {
    const module = checker.getSymbolAtLocation(file);
    const symbol = module && checker.getExportsOfModule(module).find((candidate) => candidate.name === name);
    const resolved = canonical(symbol);
    if (resolved === undefined) throw new Error(`Missing adversarial owned symbol '${name}'.`);
    return resolved;
  };
  const member = (owner: ts.Symbol, name: string): ts.Symbol => {
    const resolved = canonical(checker.getDeclaredTypeOfSymbol(owner).getProperty(name));
    if (resolved === undefined) throw new Error(`Missing adversarial owned member '${owner.name}.${name}'.`);
    return resolved;
  };
  const policyFile = fileAt(POLICY_FILE);
  const inheritanceFile = fileAt('src/coordinator/services/provider-proxy-set/inheritance.ts');
  const disappearanceFile = fileAt('src/coordinator/services/provider-containment-disappearance.ts');
  const reconcilerFile = fileAt('src/coordinator/services/provider-operation-reconciler.ts');
  const lifecycleFile = fileAt('src/coordinator/services/provider-proxy-set/index.ts');
  const localOwned = new Map<ts.Symbol, string>([
    [member(exported(policyFile, 'ProviderProxyRecoveryDispatcher'), 'begin'), 'ProviderProxyRecoveryDispatcher.begin'],
    [member(exported(policyFile, 'ProviderProxyRecoveryArbiter'), 'start'), 'ProviderProxyRecoveryArbiter.start'],
    [member(exported(policyFile, 'ProviderProxyRecoveryTurnSinks'), 'fatal'), 'ProviderProxyRecoveryTurnSinks.fatal'],
    [exported(inheritanceFile, 'recoverProviderProxySetOrdinarily'), 'recoverProviderProxySetOrdinarily'],
    [exported(inheritanceFile, 'recoverProviderProxySetAtStartup'), 'recoverProviderProxySetAtStartup'],
    [
      member(exported(disappearanceFile, 'ProviderContainmentDisappearanceConsumer'), 'containmentDisappeared'),
      'ProviderContainmentDisappearanceConsumer.containmentDisappeared',
    ],
    [
      member(exported(reconcilerFile, 'ProviderOperationReconciler'), 'containmentDisappeared'),
      'ProviderOperationReconciler.containmentDisappeared',
    ],
    [
      member(exported(lifecycleFile, 'ContainmentAbsenceAcceptance'), 'initialDisposition'),
      'ContainmentAbsenceAcceptance.initialDisposition',
    ],
    [exported(policyFile, 'isProviderProxyRecoveryFatalError'), 'isProviderProxyRecoveryFatalError'],
  ]);
  const localClasses = new Map<string, ReferenceClass>([
    ['ProviderProxyRecoveryDispatcher.begin', 'begin'],
    ['ProviderProxyRecoveryArbiter.start', 'start'],
    ['ProviderProxyRecoveryTurnSinks.fatal', 'sink'],
    ['recoverProviderProxySetOrdinarily', 'facade'],
    ['recoverProviderProxySetAtStartup', 'facade'],
    ['ProviderContainmentDisappearanceConsumer.containmentDisappeared', 'raw-result'],
    ['ProviderOperationReconciler.containmentDisappeared', 'raw-result'],
    ['ContainmentAbsenceAcceptance.initialDisposition', 'raw-result'],
    ['isProviderProxyRecoveryFatalError', 'fatal-origin'],
  ]);
  const match = (symbol: ts.Symbol | undefined): string | undefined => {
    const resolved = canonical(symbol);
    if (resolved === undefined) return undefined;
    const direct = localOwned.get(resolved);
    if (direct !== undefined) return direct;
    for (const [ownedSymbol, key] of localOwned) {
      const declarations = new Set(ownedSymbol.declarations ?? []);
      if (resolved.declarations?.some((declaration) => declarations.has(declaration)) === true) return key;
    }
    return undefined;
  };
  const bindingSymbol = (node: ts.BindingElement): ts.Symbol | undefined => {
    if (!ts.isVariableDeclaration(node.parent.parent) || node.parent.parent.initializer === undefined) {
      return undefined;
    }
    const property = node.propertyName ?? node.name;
    if (!ts.isIdentifier(property) && !ts.isStringLiteral(property)) return undefined;
    return canonical(checker.getTypeAtLocation(node.parent.parent.initializer).getProperty(property.text));
  };
  const resolvedCall = (call: ts.CallExpression): ts.Symbol | undefined => {
    const direct = checker.getSymbolAtLocation(call.expression);
    if (direct !== undefined) return direct;
    const declaration = checker.getResolvedSignature(call)?.declaration;
    return declaration !== undefined && 'name' in declaration && declaration.name !== undefined
      ? checker.getSymbolAtLocation(declaration.name)
      : undefined;
  };
  const source = fileAt(path);
  const references: Array<{
    owner: ts.FunctionLikeDeclaration | undefined;
    key: string;
    nodeKind: string;
    node: ts.Node;
  }> = [];
  const catches: Array<{ owner: ts.FunctionLikeDeclaration | undefined; node: ts.CatchClause }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBindingElement(node)) {
      const key = match(bindingSymbol(node));
      if (key !== undefined) references.push({ owner: namedOwner(node), key, nodeKind: 'BindingElement', node });
    } else if (ts.isImportSpecifier(node)) {
      const key = match(checker.getSymbolAtLocation(node.name));
      if (key !== undefined) references.push({ owner: undefined, key, nodeKind: 'ImportSpecifier', node });
    } else if (ts.isCallExpression(node)) {
      const key = match(resolvedCall(node));
      if (key !== undefined) references.push({ owner: namedOwner(node), key, nodeKind: 'CallExpression', node });
    } else if (ts.isPropertyAccessExpression(node)) {
      const key = match(checker.getSymbolAtLocation(node.name));
      if (key !== undefined) {
        references.push({ owner: namedOwner(node), key, nodeKind: 'PropertyAccessExpression', node });
      }
    } else if (ts.isCatchClause(node)) {
      catches.push({ owner: namedOwner(node), node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const bindingEscapes = references
    .filter(({ nodeKind }) => nodeKind === 'BindingElement')
    .map(({ owner, key }) => `${path} :: ${ownerName(owner)} :: BindingElement value escape for ${key}`)
    .sort();
  const valueEscapes = references
    .filter(({ key, node, nodeKind }) => {
      const referenceClass = localClasses.get(key);
      if (referenceClass === undefined || !DIRECT_CALL_ONLY_CLASSES.has(referenceClass)) return false;
      if (ts.isCallExpression(node) || nodeKind === 'ImportSpecifier') return false;
      return !isExactCallCallee(node);
    })
    .map(({ owner, key, nodeKind }) => `${path} :: ${ownerName(owner)} :: ${nodeKind} value escape for ${key}`)
    .sort();
  const ownedOccurrences = references
    .filter(({ nodeKind }) => nodeKind !== 'BindingElement')
    .map(({ owner, key, nodeKind }) => `${path} :: ${ownerName(owner)} :: ${nodeKind} :: ${key}`)
    .sort();
  const rejections = catches.map(({ owner, node }, index) => {
    const consumed = references
      .filter((reference) => reference.owner === owner)
      .map(({ key }) => key)
      .filter((value, itemIndex, values) => values.indexOf(value) === itemIndex)
      .sort();
    const returns: string[] = [];
    const collectReturns = (child: ts.Node): void => {
      if (ts.isReturnStatement(child) && child.expression !== undefined) {
        returns.push(child.expression.getText().replaceAll(/\s+/gu, ' '));
      }
      ts.forEachChild(child, collectReturns);
    };
    collectReturns(node.block);
    return `${path} :: ${ownerName(owner)} :: catch#${index + 1} :: consumed=[${consumed.join(
      ', ',
    )}] :: returned=[${returns.join(', ')}]`;
  });
  return { bindingEscapes, valueEscapes, ownedOccurrences, rejections };
}

function diagnosticsFor(program: ts.Program, path: string): string[] {
  const fileName = resolve(REPO_ROOT, path);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === fileName)
    .map((diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
}

/**
 * Every adversarial case below builds its own TypeScript program over production sources and takes ~21-27s on
 * the slower supported Node major, so each one needs its own `}, 45_000)` budget — the file-wide default is
 * 15s (`vitest/default.ts`). Vitest attaches that argument to the case it CLOSES, not the one it precedes, and
 * because it renders directly above the next `it(` it reads as though it covers it. Cases here have
 * timed out in CI for exactly that misreading, each fixed one at a time. When adding a case, give it its own
 * budget rather than assuming the line above yours applies to you.
 */
describe('provider proxy recovery policy construction', () => {
  it('enforces recovery-policy boundaries and rejection inventories', () => {
    const references = collectReferences();

    const beginInventory = callsFor('ProviderProxyRecoveryDispatcher.begin', references)
      .map((reference) => {
        const call = reference.node as ts.CallExpression;
        return `${reference.file} :: ${reference.owner} :: ${stringLiteralArgument(call, 0) ?? '<dynamic>'}`;
      })
      .sort();
    const beginAuthorizations: readonly JustifiedOccurrence[] = [
      {
        occurrence:
          'src/coordinator/services/provider-operation-reconciler.ts :: #terminalizeDisappearance :: disappearance-delivery',
        justification: 'The reconciler opens the registered durable terminalization turn for one disappearance notice.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-operation-reconciler.ts :: #terminalizeAbandonment :: representation-abandonment-delivery',
        justification: 'Abandonment terminalization retains its distinct fatal and retry ownership seam.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/inheritance.ts :: recoverProviderProxySetAtStartup :: startup-set-inheritance',
        justification: 'The startup façade opens its one inheritance classification turn.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/inheritance.ts :: recoverProviderProxySetOrdinarily :: ordinary-set-inheritance',
        justification: 'The ordinary façade opens its one inheritance classification turn.',
      },
      {
        occurrence: 'src/coordinator/services/provider-proxy-set/index.ts :: #attemptRetirement :: capsule-retirement',
        justification: 'Capsule retirement is classified by its dedicated lifecycle turn.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #attemptForeignCapsuleRetirement :: foreign-capsule-retirement',
        justification:
          'Retirement of a capsule this build may not dial is classified on its own seam, so its failures stay owner-local.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #deliverDisappearance :: disappearance-delivery',
        justification:
          'R3 requires every post-start disappearance delivery to enter the dispatcher before consumption.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #deliverAbandonment :: representation-abandonment-delivery',
        justification: 'Operator abandonment transfers each claim through its distinct acceptance seam before release.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #recoverExactCapsule :: exact-capsule-recovery',
        justification: 'Exact capsule recovery reduces redemption and absence evidence in one registered turn.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #runControlReattachmentAttempt :: control-reattachment',
        justification: 'A channel hold reduces authenticated redemption and independent absence concurrently.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #runContainmentAttempt :: containment-attempt',
        justification: 'The containment race reduces stop-and-reap and proof evidence in one registered turn.',
      },
    ];
    const expectedBegins = beginAuthorizations.map(({ occurrence }) => occurrence).sort();

    const startInventory = callsFor('ProviderProxyRecoveryArbiter.start', references)
      .map((reference) => {
        const call = reference.node as ts.CallExpression;
        return `${reference.file} :: ${reference.owner} :: ${stringObjectProperty(call.arguments[0], 'sourceId')}/${stringObjectProperty(
          call.arguments[0],
          'producerId',
        )}`;
      })
      .sort();
    const startAuthorizations: readonly JustifiedOccurrence[] = [
      {
        occurrence:
          'src/coordinator/services/provider-operation-reconciler.ts :: #terminalizeDisappearance :: terminalization/disappearance-terminalization',
        justification: 'The disappearance turn invokes only the atomic terminalization producer under this source id.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-operation-reconciler.ts :: #terminalizeAbandonment :: terminalization/disappearance-terminalization',
        justification: 'Abandonment reuses atomic terminalization while retaining its distinct consumer seam.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/inheritance.ts :: dispatchProviderProxySetInheritance :: inheritance/set-inheritance',
        justification: 'Both public inheritance façades delegate their one producer start to this adapter.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #attemptRetirement :: retirement/capsule-retirement',
        justification: 'The retirement turn invokes only the capsule-retirement producer.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #attemptForeignCapsuleRetirement :: foreign-retirement/capsule-retirement',
        justification: 'The foreign retirement turn invokes only the capsule-retirement producer.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #deliverDisappearance :: delivery/disappearance-consumer',
        justification: 'R3 routes the captured notice through the registered disappearance consumer.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #deliverAbandonment :: delivery/representation-abandonment-consumer',
        justification: 'Abandonment routes the captured notice through its separate registered consumer.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #recoverExactCapsule :: absence/containment-proof',
        justification: 'Exact recovery contributes independently proven absence under the absence source id.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #recoverExactCapsule :: redemption/capsule-redemption',
        justification: 'Exact recovery contributes capsule redemption under the redemption source id.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #runControlReattachmentAttempt :: absence/containment-proof',
        justification: 'The channel hold observes independent containment absence alongside redemption.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #runControlReattachmentAttempt :: redemption/role-control',
        justification: 'The channel hold invokes the authority-owned authenticated redemption attempt.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #runContainmentAttempt :: absence/containment-proof',
        justification: 'The containment race contributes independent absence proof under the absence source id.',
      },
      {
        occurrence:
          'src/coordinator/services/provider-proxy-set/index.ts :: #runContainmentAttempt :: stop-and-reap/role-control',
        justification: 'The containment race contributes the role-control stop attempt under its distinct source id.',
      },
    ];
    const expectedStarts = startAuthorizations.map(({ occurrence }) => occurrence).sort();
    const producerCallInventory = references
      .filter((reference) => reference.target.referenceClass === 'producer' && ts.isCallExpression(reference.node))
      .map((reference) => `${reference.file} :: ${reference.owner} :: ${reference.target.key}`)
      .sort();
    const producerAuthorizations = producerIds.map((producerId) => ({
      occurrence: `${POLICY_FILE} :: invokeProducer :: ProviderProxyRecoveryProducerPorts.${producerId}`,
      justification: `The central invokeProducer switch is the sole caller of '${producerId}'.`,
    }));
    const expectedProducerCalls = producerAuthorizations.map(({ occurrence }) => occurrence).sort();
    const directPolicyEffectViolations = references
      .filter(
        (reference) =>
          ts.isCallExpression(reference.node) &&
          reference.file !== POLICY_FILE &&
          (reference.target.referenceClass === 'producer' ||
            reference.target.referenceClass === 'sink' ||
            reference.target.referenceClass === 'effect' ||
            reference.target.referenceClass === 'fatal-sink'),
      )
      .map(
        (reference) => `${reference.file} :: ${reference.owner} :: ${reference.nodeKind} :: ${reference.target.key}`,
      );

    const consumerFiles = new Set([
      'src/coordinator/services/provider-operation-reconciler.ts',
      'src/coordinator/services/provider-proxy-set/inheritance.ts',
      'src/coordinator/services/provider-proxy-set/index.ts',
    ]);
    const forbiddenAllSettled = SOURCE_FILES.flatMap((file) => {
      if (!consumerFiles.has(relativePath(file))) return [];
      const matches: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && standardPromiseRejectionKind(node) === 'Promise.allSettled') {
          matches.push(`${relativePath(file)} :: ${ownerName(namedOwner(node))} :: Promise.allSettled`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      return matches;
    });
    const forbiddenMethodNames = ['scheduleCapsuleRetry', 'recordDeliveryOperationalFailure', 'recordDeliveryFatal'];
    const forbiddenMethods = SOURCE_FILES.flatMap((file) => {
      const matches: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          (ts.isMethodDeclaration(node) || ts.isPropertyAccessExpression(node)) &&
          forbiddenMethodNames.some((name) => node.name.getText().includes(name))
        ) {
          matches.push(`${relativePath(file)} :: ${node.name.getText()}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      return matches;
    });

    expect(
      {
        boundaryInventory: boundaryInventory(references),
        authorizationJustifications: [
          ...BOUNDARY_AUTHORIZATIONS,
          ...beginAuthorizations,
          ...startAuthorizations,
          ...producerAuthorizations,
          ...REJECTION_AUTHORIZATIONS.map(({ fingerprint, justification }) => ({
            occurrence: fingerprint,
            justification,
          })),
        ].filter(({ justification }) => justification.trim().length === 0),
        valueEscapeViolations: valueEscapeViolations(references),
        beginInventory,
        startInventory,
        producerCallInventory,
        directPolicyEffectViolations,
        rejectionNodeInventory: rejectionNodeInventory(references),
        consumerRejectionViolations: consumerRejectionViolations(references),
        forbiddenAllSettled,
        forbiddenMethods,
      },
      'project-wide provider proxy recovery policy inventory',
    ).toEqual({
      boundaryInventory: BOUNDARY_AUTHORIZATIONS.map(({ occurrence }) => occurrence).sort(),
      authorizationJustifications: [],
      valueEscapeViolations: [],
      beginInventory: expectedBegins,
      startInventory: expectedStarts,
      producerCallInventory: expectedProducerCalls,
      directPolicyEffectViolations: [],
      rejectionNodeInventory: EXPECTED_REJECTION_NODE_INVENTORY,
      consumerRejectionViolations: [],
      forbiddenAllSettled: [],
      forbiddenMethods: [],
    });
  }, 45_000);

  it('rejects destructured dispatcher and arbiter consumers', () => {
    const path = 'src/adversarial-destructured-recovery-consumer.ts';
    const program = createProductionProgram(
      new Map([
        [
          path,
          `import type {
  ProviderProxyRecoveryAnySource,
  ProviderProxyRecoveryConsumerSeam,
  ProviderProxyRecoveryDispatcher,
  ProviderProxyRecoveryExactContext,
  ProviderProxyRecoveryTurnSinks,
} from './coordinator/services/provider-proxy-recovery-policy.js';

export function consume(
  dispatcher: ProviderProxyRecoveryDispatcher,
  seam: ProviderProxyRecoveryConsumerSeam,
  context: ProviderProxyRecoveryExactContext,
  sinks: ProviderProxyRecoveryTurnSinks,
  source: ProviderProxyRecoveryAnySource,
): void {
  const { begin } = dispatcher;
  const { start } = begin(seam, context, sinks);
  start(source);
}
`,
        ],
      ]),
    );

    expect({
      diagnostics: diagnosticsFor(program, path).filter((diagnostic) => diagnostic.startsWith('TS2684:')),
      invariant: analyzeAdversarialProgram(program, path).bindingEscapes,
    }).toEqual({
      diagnostics: [
        expect.stringContaining("The 'this' context of type 'void' is not assignable"),
        expect.stringContaining("The 'this' context of type 'void' is not assignable"),
      ],
      invariant: [
        `${path} :: consume :: BindingElement value escape for ProviderProxyRecoveryArbiter.start`,
        `${path} :: consume :: BindingElement value escape for ProviderProxyRecoveryDispatcher.begin`,
      ],
    });
  }, 45_000);

  it('rejects a destructured fatal sink value escape', () => {
    const path = 'src/adversarial-destructured-recovery-fatal-sink.ts';
    const program = createProductionProgram(
      new Map([
        [
          path,
          `import type {
  ProviderProxyRecoveryTurnSinks,
  ProviderProxySetLifecycleFatalError,
} from './coordinator/services/provider-proxy-recovery-policy.js';

export function escape(sinks: ProviderProxyRecoveryTurnSinks, error: ProviderProxySetLifecycleFatalError): void {
  const { fatal } = sinks;
  fatal(error);
}
`,
        ],
      ]),
    );

    expect({
      diagnostics: diagnosticsFor(program, path),
      invariant: analyzeAdversarialProgram(program, path).valueEscapes,
    }).toEqual({
      diagnostics: [],
      invariant: [`${path} :: escape :: BindingElement value escape for ProviderProxyRecoveryTurnSinks.fatal`],
    });
  }, 45_000);

  it('rejects a raw-result method value escape', () => {
    const path = 'src/adversarial-provider-recovery-raw-result.ts';
    const program = createProductionProgram(
      new Map([
        [
          path,
          `import type {
  ContainmentDisappearanceNotice,
  ProviderContainmentDisappearanceConsumer,
} from './coordinator/services/provider-containment-disappearance.js';

export function escape(
  consumer: ProviderContainmentDisappearanceConsumer,
  notice: ContainmentDisappearanceNotice,
): void {
  const rawResult = consumer.containmentDisappeared;
  void rawResult(notice);
}
`,
        ],
      ]),
    );

    expect({
      diagnostics: diagnosticsFor(program, path),
      invariant: analyzeAdversarialProgram(program, path).valueEscapes,
    }).toEqual({
      diagnostics: [],
      invariant: [
        `${path} :: escape :: PropertyAccessExpression value escape for ProviderContainmentDisappearanceConsumer.containmentDisappeared`,
      ],
    });
  }, 45_000);

  it('rejects an external facade consumer that erases fatal provenance', () => {
    const path = 'src/adversarial-provider-recovery-consumer.ts';
    const program = createProductionProgram(
      new Map([
        [
          path,
          `import { recoverProviderProxySetOrdinarily as recover } from './coordinator/services/provider-proxy-set/inheritance.js';

export async function erase(...args: Parameters<typeof recover>) {
  try {
    return await recover(...args);
  } catch {
    return {
      kind: 'temporarily-unavailable',
      incident: { kind: 'recovery-deadline', timeoutMs: 45_000 },
    };
  }
}
`,
        ],
      ]),
    );
    const analysis = analyzeAdversarialProgram(program, path);

    expect(diagnosticsFor(program, path)).toEqual([]);
    expect(analysis.ownedOccurrences).toEqual([
      `${path} :: <module> :: ImportSpecifier :: recoverProviderProxySetOrdinarily`,
      `${path} :: erase :: CallExpression :: recoverProviderProxySetOrdinarily`,
    ]);
    expect(analysis.rejections).toEqual([
      expect.stringContaining(
        `${path} :: erase :: catch#1 :: consumed=[recoverProviderProxySetOrdinarily] :: returned=[{ kind: 'temporarily-unavailable'`,
      ),
    ]);
  }, 45_000);

  it('documents parameter-carried destructuring that erases fatal provenance', () => {
    const path = 'src/adversarial-parameter-carried-recovery-consumer.ts';
    const program = createProductionProgram(
      new Map([
        [
          path,
          `import { recoverProviderProxySetOrdinarily as realRecover } from './coordinator/services/provider-proxy-set/inheritance.js';

export async function erase(
  { recover }: { recover: typeof realRecover },
  ...args: Parameters<typeof realRecover>
) {
  try {
    return await recover(...args);
  } catch {
    return {
      kind: 'temporarily-unavailable',
      incident: { kind: 'recovery-deadline', timeoutMs: 45_000 },
    };
  }
}
`,
        ],
      ]),
    );
    const analysis = analyzeAdversarialProgram(program, path);
    const checkerSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const noticeStart = checkerSource.indexOf('/**\n * PARTIAL ENFORCEMENT');
    const noticeEnd = checkerSource.indexOf(' */', noticeStart);
    const limitationNotice = checkerSource.slice(noticeStart, noticeEnd);

    expect({
      diagnostics: diagnosticsFor(program, path),
      ownedOccurrences: analysis.ownedOccurrences,
      rejections: analysis.rejections,
      namesDestructuredFunctionParameters: limitationNotice.includes('destructured function parameters'),
    }).toEqual({
      diagnostics: [],
      ownedOccurrences: [`${path} :: <module> :: ImportSpecifier :: recoverProviderProxySetOrdinarily`],
      rejections: [expect.stringContaining(`${path} :: erase :: catch#1 :: consumed=[]`)],
      namesDestructuredFunctionParameters: true,
    });
  }, 45_000);

  it('rejects catch relabeling of dispatcher fatal evidence', () => {
    const path = 'src/adversarial-provider-recovery-relabel.ts';
    const program = createProductionProgram(
      new Map([
        [
          path,
          `import { isProviderProxyRecoveryFatalError } from './coordinator/services/provider-proxy-recovery-policy.js';
import { recoverProviderProxySetOrdinarily } from './coordinator/services/provider-proxy-set/inheritance.js';

export async function relabel(...args: Parameters<typeof recoverProviderProxySetOrdinarily>) {
  try {
    return await recoverProviderProxySetOrdinarily(...args);
  } catch (error) {
    if (isProviderProxyRecoveryFatalError(error)) {
      return {
        kind: 'temporarily-unavailable',
        incident: { kind: 'recovery-deadline', timeoutMs: 45_000 },
      };
    }
    throw error;
  }
}
`,
        ],
      ]),
    );
    const analysis = analyzeAdversarialProgram(program, path);

    expect(diagnosticsFor(program, path)).toEqual([]);
    expect(analysis.rejections).toEqual([
      expect.stringMatching(
        /catch#1 :: consumed=\[isProviderProxyRecoveryFatalError, recoverProviderProxySetOrdinarily\] :: returned=\[\{ kind: 'temporarily-unavailable'/u,
      ),
    ]);
  }, 45_000);

  it('keeps dispatcher fatal origin private', () => {
    const path = 'src/adversarial-fatal-construction.ts';
    const program = createProductionProgram(
      new Map([
        [
          path,
          `import { ProviderProxySetLifecycleFatalError } from './coordinator/services/provider-proxy-recovery-policy.js';

export const constructed = new ProviderProxySetLifecycleFatalError(
  'set-inheritance',
  'forged',
  { cause: new Error('forged'), seam: 'ordinary-set-inheritance', producerId: 'set-inheritance' },
);

export const structural: ProviderProxySetLifecycleFatalError = {
  name: 'ProviderProxySetLifecycleFatalError',
  message: 'forged',
  stage: 'set-inheritance',
  seam: 'ordinary-set-inheritance',
  producerId: 'set-inheritance',
};
`,
        ],
      ]),
    );
    const diagnostics = diagnosticsFor(program, path);

    expect(diagnostics).toEqual([
      expect.stringContaining("'ProviderProxySetLifecycleFatalError' only refers to a type"),
      expect.stringContaining("Property '[providerProxyRecoveryFatalOrigin]' is missing"),
    ]);
  }, 45_000);

  it('keeps the producer registry closed and explicit', () => {
    const source = readFileSync(resolve(REPO_ROOT, POLICY_FILE), 'utf8');
    expect({
      declaredProducerMembers: producerIds.filter((id) => memberSymbol(producerPorts, id) !== undefined),
      hasIndexSignature: /interface ProviderProxyRecoveryProducerPorts\s*\{[^}]*\[[^\]]+\]/su.test(source),
    }).toEqual({ declaredProducerMembers: producerIds, hasIndexSignature: false });
  });
});
