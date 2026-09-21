import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHUTDOWN_PATH = 'src/coordinator/shutdown.ts';
const SETTLEMENT_PATH = 'src/obligation/settlement.ts';
const SHUTDOWN_SETTLEMENT_PATH = 'src/coordinator/shutdown-settlement.ts';
const ADMISSION_PATH = 'src/coordinator/live/admission.ts';
const FIXTURE_ROOT = 'tests/invariants/fixtures/shutdown-teardown-containment';
const SETTLEMENT_IMPORTS = new Map([
  ['createShutdownSettlementLedger', './shutdown-settlement.js'],
  ['createJoinableSettlementTask', '../obligation/settlement.js'],
]);
const SETTLEMENT_GATE_CONSTRUCTORS = new Set(['settled', 'delegated', 'held', 'unaccepted']);

type NamedFunction = ts.FunctionDeclaration | ts.MethodDeclaration;

function parseSource(canonicalPath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(canonicalPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function readSource(canonicalPath: string): ts.SourceFile {
  return parseSource(canonicalPath, readFileSync(resolve(REPO_ROOT, canonicalPath), 'utf8'));
}

function readFixture(name: string): ts.SourceFile {
  const fixturePath = `${FIXTURE_ROOT}/${name}.ts`;
  const source = readFileSync(resolve(REPO_ROOT, `${fixturePath}.txt`), 'utf8');
  return parseSource(fixturePath, source);
}

function readSourceTree(canonicalDirectory: string): ts.SourceFile[] {
  return readdirSync(resolve(REPO_ROOT, canonicalDirectory), { withFileTypes: true }).flatMap((entry) => {
    const canonicalPath = `${canonicalDirectory}/${entry.name}`;
    if (entry.isDirectory()) return readSourceTree(canonicalPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [readSource(canonicalPath)] : [];
  });
}

function functionName(node: NamedFunction): string | null {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

function findFunction(sourceFile: ts.SourceFile, name: string): NamedFunction {
  let match: NamedFunction | undefined;

  function visit(node: ts.Node): void {
    if (
      match === undefined &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      functionName(node) === name
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!match) throw new Error(`${sourceFile.fileName}: expected function ${name}`);
  return match;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionName(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (!ts.isPropertyAccessExpression(current)) return null;

  const owner = expressionName(current.expression);
  return owner === null ? null : `${owner}.${current.name.text}`;
}

function formatViolation(functionNode: NamedFunction, node: ts.Node, detail: string): string {
  const sourceFile = functionNode.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${line + 1} ${functionName(functionNode)}: ${detail}`;
}

type ShutdownDispositionName = 'held' | 'settled' | 'delegated' | 'unaccepted';

function isShutdownDispositionName(value: string): value is ShutdownDispositionName {
  return value === 'held' || value === 'settled' || value === 'delegated' || value === 'unaccepted';
}

function shutdownDispositionLiteralViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === 'disposition' &&
      ts.isStringLiteral(unwrapExpression(node.initializer))
    ) {
      const value = unwrapExpression(node.initializer) as ts.StringLiteral;
      if (isShutdownDispositionName(value.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(`${sourceFile.fileName}:${line + 1} constructs shutdown disposition '${value.text}'`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function objectDisposition(node: ts.ObjectLiteralExpression): ShutdownDispositionName | null {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || property.name.getText(node.getSourceFile()) !== 'disposition') continue;
    const value = unwrapExpression(property.initializer);
    if (ts.isStringLiteral(value) && isShutdownDispositionName(value.text)) return value.text;
  }
  return null;
}

function typeReferencesShutdownDisposition(type: ts.TypeNode | undefined): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === 'ShutdownSequenceDisposition') found = true;
    if (!found) ts.forEachChild(node, visit);
  }
  if (type !== undefined) visit(type);
  return found;
}

function typeDispositionNames(type: ts.TypeNode | undefined): Set<string> {
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text.endsWith('Disposition')) names.add(node.text);
    ts.forEachChild(node, visit);
  }
  if (type !== undefined) visit(type);
  return names;
}

function hasShutdownDispositionContext(node: ts.ObjectLiteralExpression): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) &&
      typeReferencesShutdownDisposition(current.type)
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(current) && typeReferencesShutdownDisposition(current.type)) return true;
    if (ts.isFunctionLike(current)) return typeReferencesShutdownDisposition(current.type);
  }
  return false;
}

function hasExplicitUnrelatedDispositionContext(node: ts.ObjectLiteralExpression): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    let type: ts.TypeNode | undefined;
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isVariableDeclaration(current)) {
      type = current.type;
    } else if (ts.isFunctionLike(current)) {
      type = current.type;
    } else {
      continue;
    }
    const names = typeDispositionNames(type);
    if (names.has('ShutdownSequenceDisposition')) return false;
    if (names.size > 0) return true;
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function hasProperties(node: ts.ObjectLiteralExpression, required: readonly string[]): boolean {
  const properties = new Set(
    node.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isMethodSignature(property)
        ? [property.name.getText(node.getSourceFile())]
        : [],
    ),
  );
  return required.every((property) => properties.has(property));
}

function hasShutdownHeldPayload(node: ts.ObjectLiteralExpression): boolean {
  return hasProperties(node, ['reason', 'exit', 'retryAfter', 'undischarged', 'retainedAuthority', 'retry']);
}

function isSettlementGateConstruction(node: ts.ObjectLiteralExpression): boolean {
  if (node.getSourceFile().fileName !== SETTLEMENT_PATH) return false;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      !ts.isMethodDeclaration(current) ||
      !SETTLEMENT_GATE_CONSTRUCTORS.has(current.name.getText(current.getSourceFile()))
    ) {
      continue;
    }
    const owner = current.parent;
    return ts.isClassDeclaration(owner) && owner.name?.text === 'SettlementGate';
  }
  return false;
}

function shutdownDispositionConstructorViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const disposition = objectDisposition(node);
      const isSettlementModule = sourceFile.fileName === SETTLEMENT_PATH;
      if (
        disposition !== null &&
        !isSettlementGateConstruction(node) &&
        (isSettlementModule ||
          hasShutdownDispositionContext(node) ||
          (disposition === 'held' && hasShutdownHeldPayload(node)) ||
          (disposition === 'delegated' && !hasExplicitUnrelatedDispositionContext(node)) ||
          (disposition === 'unaccepted' && !hasExplicitUnrelatedDispositionContext(node)) ||
          (disposition === 'settled' && !hasExplicitUnrelatedDispositionContext(node)))
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(
          `${sourceFile.fileName}:${line + 1} constructs shutdown disposition '${disposition}' outside SettlementGate`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function isCaughtWithin(node: ts.Node, boundary: NamedFunction): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (!ts.isTryStatement(current) || current.catchClause === undefined) continue;
    for (let descendant = node; descendant !== current; descendant = descendant.parent) {
      if (descendant.parent === current) return descendant === current.tryBlock;
    }
  }
  return false;
}

function shutdownThrowViolations(sourceFile: ts.SourceFile): string[] {
  const shutdownSequence = findFunction(sourceFile, 'runShutdownSequence');
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (node !== shutdownSequence && ts.isFunctionLike(node)) return;
    if (ts.isThrowStatement(node) && !isCaughtWithin(node, shutdownSequence)) {
      violations.push(formatViolation(shutdownSequence, node, 'throw reaches the shutdown sequence boundary'));
    }
    ts.forEachChild(node, visit);
  }

  if (shutdownSequence.body) visit(shutdownSequence.body);
  return violations;
}

function shutdownAwaitBoundaryViolations(sourceFile: ts.SourceFile): string[] {
  const shutdownSequence = findFunction(sourceFile, 'runShutdownSequence');
  const violations: string[] = [];
  const obligationTasks = new Set<ts.SignatureDeclaration>();
  const obligationBindings = new Map<string, ts.ObjectLiteralExpression>();

  function taskClosure(obligation: ts.ObjectLiteralExpression): ts.FunctionLikeDeclaration | null {
    for (const property of obligation.properties) {
      if (!ts.isPropertyAssignment(property) || property.name.getText(sourceFile) !== 'task') continue;
      const task = unwrapExpression(property.initializer);
      return ts.isArrowFunction(task) || ts.isFunctionExpression(task) ? task : null;
    }
    return null;
  }

  function collectObligations(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(unwrapExpression(node.initializer))
    ) {
      obligationBindings.set(node.name.text, unwrapExpression(node.initializer) as ts.ObjectLiteralExpression);
    }
    if (ts.isCallExpression(node)) {
      const boundary = expressionName(node.expression);
      if ((boundary === 'ledger.run' || boundary === 'ledger.gate') && node.arguments.length === 1) {
        const argument = unwrapExpression(node.arguments[0]);
        const obligation = ts.isObjectLiteralExpression(argument)
          ? argument
          : ts.isIdentifier(argument)
            ? obligationBindings.get(argument.text)
            : undefined;
        const task = obligation && taskClosure(obligation);
        if (task) obligationTasks.add(task);
      }
    }
    ts.forEachChild(node, collectObligations);
  }

  if (shutdownSequence.body) collectObligations(shutdownSequence.body);

  function visit(node: ts.Node): void {
    if (ts.isAwaitExpression(node)) {
      const expression = unwrapExpression(node.expression);
      let crossesLedger = ts.isCallExpression(expression) && expressionName(expression.expression) === 'ledger.run';
      for (let current: ts.Node | undefined = node.parent; !crossesLedger && current; current = current.parent) {
        if (current === shutdownSequence) break;
        if (ts.isFunctionLike(current)) {
          crossesLedger = obligationTasks.has(current);
          break;
        }
      }
      if (!crossesLedger) {
        violations.push(formatViolation(shutdownSequence, node, 'await bypasses the settlement ledger'));
      }
    }
    ts.forEachChild(node, visit);
  }

  if (shutdownSequence.body) visit(shutdownSequence.body);
  return violations;
}

function shutdownReturnViolations(sourceFile: ts.SourceFile): string[] {
  const shutdownSequence = findFunction(sourceFile, 'runShutdownSequence');
  const returns: ts.ReturnStatement[] = [];

  function visit(node: ts.Node): void {
    if (node !== shutdownSequence && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  }

  if (shutdownSequence.body) visit(shutdownSequence.body);
  if (returns.length !== 1) {
    return [`${sourceFile.fileName} runShutdownSequence: expected one exit-gate return, found ${returns.length}`];
  }

  const expression = returns[0].expression && unwrapExpression(returns[0].expression);
  if (
    expression === undefined ||
    !ts.isCallExpression(expression) ||
    expressionName(expression.expression) !== 'ledger.gate' ||
    expression.arguments.length !== 1 ||
    expression.arguments[0].getText(sourceFile) !== 'authorityRelease'
  ) {
    return [formatViolation(shutdownSequence, returns[0], 'return bypasses ledger.gate(authorityRelease)')];
  }
  return [];
}

function settlementConstructorImportViolations(sourceFile: ts.SourceFile): string[] {
  const imports = new Map<string, string[]>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (!SETTLEMENT_IMPORTS.has(element.name.text)) continue;
      const modules = imports.get(element.name.text) ?? [];
      modules.push(statement.moduleSpecifier.text);
      imports.set(element.name.text, modules);
    }
  }

  return [...SETTLEMENT_IMPORTS].flatMap(([constructor, expectedModule]) => {
    const modules = imports.get(constructor) ?? [];
    return modules.length === 1 && modules[0] === expectedModule
      ? []
      : [`${sourceFile.fileName}: ${constructor} must be imported once from ${expectedModule}`];
  });
}

function settlementConstructorDefinitionViolations(sourceFile: ts.SourceFile, expected: ReadonlySet<string>): string[] {
  const definitions = sourceFile.statements.flatMap((statement) => {
    if (
      (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
      statement.name !== undefined &&
      expected.has(statement.name.text)
    ) {
      return [statement.name.text];
    }
    return [];
  });

  return [...expected].flatMap((constructor) =>
    definitions.filter((definition) => definition === constructor).length === 1
      ? []
      : [`${sourceFile.fileName}: ${constructor} must have one definition in the settlement module`],
  );
}

function cleanupHandleLoop(childTermination: NamedFunction): ts.ForOfStatement | null {
  let match: ts.ForOfStatement | null = null;

  function visit(node: ts.Node): void {
    if (match !== null) return;
    if (ts.isForOfStatement(node)) {
      const iterable = unwrapExpression(node.expression);
      if (ts.isCallExpression(iterable) && expressionName(iterable.expression) === 'this.cleanupHandles.values') {
        match = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  if (childTermination.body) visit(childTermination.body);
  return match;
}

function loopBindingName(loop: ts.ForOfStatement): string | null {
  if (!ts.isVariableDeclarationList(loop.initializer)) return null;
  const declaration = loop.initializer.declarations[0];
  return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
}

function isInsideCaughtTry(node: ts.Node, loop: ts.ForOfStatement): boolean {
  for (let current = node.parent; current && current !== loop; current = current.parent) {
    if (ts.isTryStatement(current) && current.catchClause !== undefined) {
      for (let ancestor = node.parent; ancestor && ancestor !== current; ancestor = ancestor.parent) {
        if (ancestor === current.tryBlock) return true;
      }
    }
  }
  return false;
}

function childTerminationViolations(sourceFile: ts.SourceFile, functionName: string): string[] {
  const childTermination = findFunction(sourceFile, functionName);
  const loop = cleanupHandleLoop(childTermination);
  if (loop === null) {
    return [formatViolation(childTermination, childTermination, 'missing cleanupHandles.values() termination loop')];
  }

  const cleanupName = loopBindingName(loop);
  if (cleanupName === null) {
    return [formatViolation(childTermination, loop, 'cleanup handle loop must use an exact identifier binding')];
  }

  const cleanupCalls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(unwrapExpression(node.expression)) &&
      expressionName(node.expression) === cleanupName
    ) {
      cleanupCalls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(loop.statement);

  if (cleanupCalls.length === 0) {
    return [formatViolation(childTermination, loop, `cleanup handle ${cleanupName} is never called`)];
  }

  return cleanupCalls
    .filter((call) => !isInsideCaughtTry(call, loop))
    .map((call) =>
      formatViolation(childTermination, call, `${cleanupName}() bypasses per-handle try/catch containment`),
    );
}

describe('shutdown teardown containment invariant', () => {
  it('keeps shutdown disposition construction behind the settlement gate', () => {
    const shutdownSource = readSource(SHUTDOWN_PATH);
    const settlementSource = readSource(SETTLEMENT_PATH);
    const shutdownSettlementSource = readSource(SHUTDOWN_SETTLEMENT_PATH);
    expect([
      ...shutdownDispositionLiteralViolations(shutdownSource),
      ...readSourceTree('src').flatMap(shutdownDispositionConstructorViolations),
      ...shutdownThrowViolations(shutdownSource),
      ...shutdownAwaitBoundaryViolations(shutdownSource),
      ...shutdownReturnViolations(shutdownSource),
      ...settlementConstructorImportViolations(shutdownSource),
      ...settlementConstructorDefinitionViolations(
        settlementSource,
        new Set(['SettlementGate', 'SettlementLedger', 'createJoinableSettlementTask']),
      ),
      ...settlementConstructorDefinitionViolations(
        shutdownSettlementSource,
        new Set(['createShutdownSettlementLedger']),
      ),
    ]).toEqual([]);
  });

  it('rejects a bare awaited shutdown finalizer mutation', () => {
    expect(shutdownAwaitBoundaryViolations(readFixture('shutdown-bare-await'))).toEqual([
      `${FIXTURE_ROOT}/shutdown-bare-await.ts:2 runShutdownSequence: await bypasses the settlement ledger`,
    ]);
  });

  it('rejects a fire-and-forget nested await outside the settlement ledger', () => {
    const mutation = parseSource(
      SHUTDOWN_PATH,
      `async function runShutdownSequence() {
        void (async () => {
          await terminateAllFn();
        })();
        return ledger.gate(authorityRelease);
      }`,
    );
    expect(shutdownAwaitBoundaryViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH}:3 runShutdownSequence: await bypasses the settlement ledger`,
    ]);
  });

  it('rejects an awaited obligation factory inside ledger.run', () => {
    const mutation = parseSource(
      SHUTDOWN_PATH,
      `async function runShutdownSequence() {
        await ledger.run(await createObligationAfterRunningFinalizer());
        return ledger.gate(authorityRelease);
      }`,
    );
    expect(shutdownAwaitBoundaryViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH}:2 runShutdownSequence: await bypasses the settlement ledger`,
    ]);
  });

  it('rejects a shutdown path without the single settlement-gate return', () => {
    const mutation = parseSource(SHUTDOWN_PATH, 'async function runShutdownSequence() {}');
    expect(shutdownReturnViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH} runShutdownSequence: expected one exit-gate return, found 0`,
    ]);
  });

  it('rejects disposition construction in the demolition plan', () => {
    const mutation = parseSource(
      SHUTDOWN_PATH,
      `async function runShutdownSequence() {
        return { disposition: 'held' };
      }`,
    );
    expect(shutdownDispositionLiteralViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH}:2 constructs shutdown disposition 'held'`,
    ]);
  });

  it('rejects an uncaught throw from the shutdown sequence', () => {
    const mutation = parseSource(
      SHUTDOWN_PATH,
      `async function runShutdownSequence() {
        throw new Error('escaped');
      }`,
    );
    expect(shutdownThrowViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH}:2 runShutdownSequence: throw reaches the shutdown sequence boundary`,
    ]);
  });

  it('rejects a competing return beside the settlement gate', () => {
    const mutation = parseSource(
      SHUTDOWN_PATH,
      `async function runShutdownSequence(condition: boolean) {
        if (condition) return Promise.resolve();
        return ledger.gate(authorityRelease);
      }`,
    );
    expect(shutdownReturnViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH} runShutdownSequence: expected one exit-gate return, found 2`,
    ]);
  });

  it('rejects settlement constructors imported from another module', () => {
    const mutation = parseSource(
      SHUTDOWN_PATH,
      `import { createShutdownSettlementLedger } from './shutdown-settlement.js';
       import { createJoinableSettlementTask } from './shutdown.js';`,
    );
    expect(settlementConstructorImportViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH}: createJoinableSettlementTask must be imported once from ../obligation/settlement.js`,
    ]);
  });

  it('rejects a competing disposition constructor in the settlement module', () => {
    const mutation = parseSource(
      SETTLEMENT_PATH,
      `function competingConstructor(): ShutdownSequenceDisposition {
        return { disposition: 'settled' };
      }`,
    );
    expect(shutdownDispositionConstructorViolations(mutation)).toEqual([
      `${SETTLEMENT_PATH}:2 constructs shutdown disposition 'settled' outside SettlementGate`,
    ]);
  });

  it('rejects an explicitly typed disposition constructor outside the settlement module', () => {
    const competingPath = 'src/coordinator/competing-shutdown.ts';
    const mutation = parseSource(
      competingPath,
      `import type { ShutdownSequenceDisposition } from './shutdown-settlement.js';
       function competingConstructor(): ShutdownSequenceDisposition {
         return { disposition: 'settled' };
       }`,
    );
    expect(shutdownDispositionConstructorViolations(mutation)).toEqual([
      `${competingPath}:3 constructs shutdown disposition 'settled' outside SettlementGate`,
    ]);
  });

  it('rejects an unannotated inferred settled disposition outside the gate', () => {
    const competingPath = 'src/coordinator/competing-shutdown.ts';
    const mutation = parseSource(
      competingPath,
      `function competingConstructor() {
        return { disposition: 'settled' } as const;
      }`,
    );
    expect(shutdownDispositionConstructorViolations(mutation)).toEqual([
      `${competingPath}:2 constructs shutdown disposition 'settled' outside SettlementGate`,
    ]);
  });

  it('rejects an unannotated inferred delegated disposition outside the gate', () => {
    const competingPath = 'src/coordinator/competing-shutdown.ts';
    const mutation = parseSource(
      competingPath,
      `function competingConstructor() {
        return { disposition: 'delegated', undischarged: [], acceptance: {} } as const;
      }`,
    );
    expect(shutdownDispositionConstructorViolations(mutation)).toEqual([
      `${competingPath}:2 constructs shutdown disposition 'delegated' outside SettlementGate`,
    ]);
  });

  it('contains every cleanup call in the child-termination loop', () => {
    expect(childTerminationViolations(readSource(ADMISSION_PATH), 'terminateRegisteredChildren')).toEqual([]);
  });

  it('rejects a bare child-cleanup mutation', () => {
    expect(childTerminationViolations(readFixture('terminate-all-bare-cleanup'), 'terminateAll')).toEqual([
      `${FIXTURE_ROOT}/terminate-all-bare-cleanup.ts:4 terminateAll: ` +
        'cleanup() bypasses per-handle try/catch containment',
    ]);
  });
});
