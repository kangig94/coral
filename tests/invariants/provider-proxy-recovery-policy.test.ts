import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POLICY_FILE = 'src/coordinator/services/provider-proxy-recovery-policy.ts';

function createProductionProgram(): ts.Program {
  const configPath = resolve(REPO_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT, undefined, configPath);
  return ts.createProgram({
    rootNames: parsed.fileNames.filter((fileName) => fileName.startsWith(resolve(REPO_ROOT, 'src'))),
    options: {
      ...parsed.options,
      composite: false,
      incremental: false,
      noEmit: true,
      tsBuildInfoFile: undefined,
    },
  });
}

const PROGRAM = createProductionProgram();
const CHECKER = PROGRAM.getTypeChecker();
const SOURCE_FILES = PROGRAM.getSourceFiles().filter(
  (sourceFile) => !sourceFile.isDeclarationFile && sourceFile.fileName.startsWith(`${resolve(REPO_ROOT, 'src')}/`),
);

type ReferenceClass = 'factory' | 'begin' | 'start' | 'producer' | 'sink' | 'effect' | 'fatal-sink';

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
const producerIds = [
  'disappearance-terminalization',
  'role-control',
  'set-inheritance',
  'capsule-redemption',
  'containment-proof',
  'capsule-rewrite',
  'capsule-retirement',
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
];

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

function collectReferences(): Reference[] {
  const references: Reference[] = [];
  const seen = new Set<string>();
  const record = (file: ts.SourceFile, node: ts.Node, symbol: ts.Symbol | undefined, nodeKind: string): void => {
    const target = matchOwnedSymbol(symbol);
    if (target === undefined) return;
    const key = `${file.fileName}:${node.getStart(file)}:${node.getEnd()}:${target.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ file: relativePath(file), owner: ownerName(namedOwner(node)), nodeKind, target, node });
  };

  for (const file of SOURCE_FILES) {
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const contextual = CHECKER.getContextualType(node);
        if (contextual !== undefined) {
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
      }
      if (ts.isCallExpression(node)) {
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
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return references;
}

const ALLOWED_FILES = new Map<string, ReadonlySet<ReferenceClass>>([
  [POLICY_FILE, new Set<ReferenceClass>(['factory', 'begin', 'start', 'producer', 'sink', 'effect', 'fatal-sink'])],
  ['src/coordinator/services/provider-operation-reconciler.ts', new Set<ReferenceClass>(['begin', 'start', 'sink'])],
  ['src/coordinator/services/provider-proxy-set-inheritance.ts', new Set<ReferenceClass>(['begin', 'start', 'sink'])],
  ['src/coordinator/services/provider-proxy-set-lifecycle.ts', new Set<ReferenceClass>(['begin', 'start', 'sink'])],
  ['src/coordinator/live/provider-proxy/role-control.ts', new Set<ReferenceClass>()],
  ['src/jobs/provider-operation-terminalization.ts', new Set<ReferenceClass>()],
  ['src/coordinator/composition/execution-services.ts', new Set<ReferenceClass>(['factory', 'producer', 'fatal-sink'])],
]);

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

function rejectionFingerprint(owner: ts.FunctionLikeDeclaration, catchClause: ts.CatchClause, ordinal: number): string {
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
  return `${relativePath(owner.getSourceFile())} :: ${ownerName(owner)} :: catch#${ordinal} :: calls=[${calls.join(
    ', ',
  )}] assignments=[${assignments.join(', ')}]`;
}

function consumerRejectionViolations(references: readonly Reference[]): string[] {
  const owners = new Set<ts.FunctionLikeDeclaration>();
  for (const reference of references) {
    if (reference.target.referenceClass !== 'begin' && reference.target.referenceClass !== 'start') continue;
    if (reference.file === POLICY_FILE) continue;
    const owner = namedOwner(reference.node);
    if (owner !== undefined) owners.add(owner);
  }
  const violations: string[] = [];
  for (const owner of owners) {
    let ordinal = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        ordinal += 1;
        violations.push(rejectionFingerprint(owner, node, ordinal));
      }
      if (
        ts.isCallExpression(node) &&
        ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'then' &&
            node.arguments.length > 1) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.expression.getText() === 'Promise' &&
            node.expression.name.text === 'allSettled'))
      ) {
        violations.push(
          `${relativePath(owner.getSourceFile())} :: ${ownerName(owner)} :: ${node.expression.getText()} rejection/join`,
        );
      }
      ts.forEachChild(node, visit);
    };
    if (owner.body !== undefined) visit(owner.body);
  }
  return violations;
}

function rejectionNodeInventory(): string[] {
  const inventory: string[] = [];
  const catchOrdinals = new Map<string, number>();
  for (const file of SOURCE_FILES) {
    const path = relativePath(file);
    if (!ALLOWED_FILES.has(path)) continue;
    const visit = (node: ts.Node): void => {
      const owner = namedOwner(node);
      const name = ownerName(owner);
      if (ts.isCatchClause(node) && owner !== undefined) {
        const ordinalKey = `${path}:${name}`;
        const ordinal = (catchOrdinals.get(ordinalKey) ?? 0) + 1;
        catchOrdinals.set(ordinalKey, ordinal);
        inventory.push(rejectionFingerprint(owner, node, ordinal));
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const kind =
          callee.name.text === 'catch'
            ? 'Promise.catch'
            : callee.name.text === 'then' && node.arguments.length > 1
              ? 'Promise.then(rejected)'
              : callee.expression.getText() === 'Promise' && callee.name.text === 'allSettled'
                ? 'Promise.allSettled'
                : null;
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
  'src/coordinator/live/provider-proxy/role-control.ts :: establishRoleControl :: catch#3 :: calls=[classifyRoleControlFailure] assignments=[]',
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
  'src/coordinator/services/provider-operation-reconciler.ts :: #poll :: catch#2 :: calls=[this.#deps.onError, providerOperationErrorReason] assignments=[]',
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
  'src/coordinator/services/provider-operation-reconciler.ts :: requestStop :: catch#1 :: calls=[this.#deps.onError, providerOperationErrorReason] assignments=[]',
  'src/coordinator/services/provider-proxy-recovery-policy.ts :: runProviderProxyRecoveryDeadline :: catch#1 :: calls=[] assignments=[]',
  'src/coordinator/services/provider-proxy-recovery-policy.ts :: start :: Promise.then(rejected) :: Promise.resolve(produced).then',
  'src/coordinator/services/provider-proxy-recovery-policy.ts :: start :: catch#1 :: calls=[submit, classifyRejection] assignments=[]',
  'src/coordinator/services/provider-proxy-set-inheritance.ts :: attemptProviderProxySetInheritance :: catch#1 :: calls=[deps.proveContainmentAbsent] assignments=[]',
  'src/coordinator/services/provider-proxy-set-inheritance.ts :: attemptProviderProxySetInheritance :: catch#2 :: calls=[] assignments=[]',
  'src/coordinator/services/provider-proxy-set-inheritance.ts :: proveProviderProxySetContainmentAbsent :: catch#1 :: calls=[] assignments=[]',
  'src/coordinator/services/provider-proxy-set-inheritance.ts :: redeemCapsule :: catch#1 :: calls=[heartbeatAssembly.stop, client.close] assignments=[]',
  'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #deliverDisappearance :: catch#1 :: calls=[this.#slots.get, slot.pendingOperations.has, operationKey, this.#failDisappearanceDelivery, String] assignments=[]',
  'src/coordinator/services/provider-proxy-set-lifecycle.ts :: containmentAbsent :: Promise.catch :: authorityToClose .initiateControlClose() .catch',
  'src/coordinator/services/provider-proxy-set-lifecycle.ts :: createInitialDispositionLatch :: Promise.catch :: promise.catch',
  'src/jobs/provider-operation-terminalization.ts :: terminalizeProviderOperation :: catch#1 :: calls=[] assignments=[]',
] as const;

describe('provider proxy recovery policy construction', () => {
  it('rejects unclassified recovery catches and direct policy effects', () => {
    const references = collectReferences();
    const perimeterViolations = references
      .filter((reference) => !ALLOWED_FILES.get(reference.file)?.has(reference.target.referenceClass))
      .map(
        (reference) => `${reference.file} :: ${reference.owner} :: ${reference.nodeKind} :: ${reference.target.key}`,
      );

    const beginInventory = callsFor('ProviderProxyRecoveryDispatcher.begin', references)
      .map((reference) => {
        const call = reference.node as ts.CallExpression;
        return `${reference.file} :: ${reference.owner} :: ${stringLiteralArgument(call, 0) ?? '<dynamic>'}`;
      })
      .sort();
    const expectedBegins = [
      'src/coordinator/services/provider-operation-reconciler.ts :: #terminalizeDisappearance :: disappearance-delivery',
      'src/coordinator/services/provider-proxy-set-inheritance.ts :: recoverProviderProxySetAtStartup :: startup-set-inheritance',
      'src/coordinator/services/provider-proxy-set-inheritance.ts :: recoverProviderProxySetOrdinarily :: ordinary-set-inheritance',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #attemptRetirement :: capsule-retirement',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #recoverExactCapsule :: exact-capsule-recovery',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #redeemOpaqueCapsule :: opaque-capsule-redemption',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #rewriteOpaqueCapsule :: opaque-capsule-rewrite',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #runContainmentAttempt :: containment-attempt',
    ].sort();

    const startInventory = callsFor('ProviderProxyRecoveryArbiter.start', references)
      .map((reference) => {
        const call = reference.node as ts.CallExpression;
        return `${reference.file} :: ${reference.owner} :: ${stringObjectProperty(call.arguments[0], 'sourceId')}/${stringObjectProperty(
          call.arguments[0],
          'producerId',
        )}`;
      })
      .sort();
    const expectedStarts = [
      'src/coordinator/services/provider-operation-reconciler.ts :: #terminalizeDisappearance :: terminalization/disappearance-terminalization',
      'src/coordinator/services/provider-proxy-set-inheritance.ts :: dispatchProviderProxySetInheritance :: inheritance/set-inheritance',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #attemptRetirement :: retirement/capsule-retirement',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #recoverExactCapsule :: absence/containment-proof',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #recoverExactCapsule :: redemption/capsule-redemption',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #redeemOpaqueCapsule :: redemption/capsule-redemption',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #rewriteOpaqueCapsule :: rewrite/capsule-rewrite',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #runContainmentAttempt :: absence/containment-proof',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts :: #runContainmentAttempt :: stop-and-reap/role-control',
    ].sort();
    const producerCallInventory = references
      .filter((reference) => reference.target.referenceClass === 'producer' && ts.isCallExpression(reference.node))
      .map((reference) => `${reference.file} :: ${reference.owner} :: ${reference.target.key}`)
      .sort();
    const expectedProducerCalls = producerIds
      .map((producerId) => `${POLICY_FILE} :: invokeProducer :: ProviderProxyRecoveryProducerPorts.${producerId}`)
      .sort();
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
      'src/coordinator/services/provider-proxy-set-inheritance.ts',
      'src/coordinator/services/provider-proxy-set-lifecycle.ts',
    ]);
    const forbiddenAllSettled = SOURCE_FILES.flatMap((file) => {
      if (!consumerFiles.has(relativePath(file))) return [];
      const matches: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText() === 'Promise' &&
          node.expression.name.text === 'allSettled'
        ) {
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
        perimeterViolations,
        beginInventory,
        startInventory,
        producerCallInventory,
        directPolicyEffectViolations,
        rejectionNodeInventory: rejectionNodeInventory(),
        consumerRejectionViolations: consumerRejectionViolations(references),
        forbiddenAllSettled,
        forbiddenMethods,
      },
      'project-wide provider proxy recovery policy inventory',
    ).toEqual({
      perimeterViolations: [],
      beginInventory: expectedBegins,
      startInventory: expectedStarts,
      producerCallInventory: expectedProducerCalls,
      directPolicyEffectViolations: [],
      rejectionNodeInventory: EXPECTED_REJECTION_NODE_INVENTORY,
      consumerRejectionViolations: [],
      forbiddenAllSettled: [],
      forbiddenMethods: [],
    });
  });

  it('keeps the producer registry closed and explicit', () => {
    const source = readFileSync(resolve(REPO_ROOT, POLICY_FILE), 'utf8');
    expect({
      declaredProducerMembers: producerIds.filter((id) => memberSymbol(producerPorts, id) !== undefined),
      hasIndexSignature: /interface ProviderProxyRecoveryProducerPorts\s*\{[^}]*\[[^\]]+\]/su.test(source),
    }).toEqual({ declaredProducerMembers: producerIds, hasIndexSignature: false });
  });
});
