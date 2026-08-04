import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const AUTHORITY_MODULE = 'src/coordinator/bound-coordinator-authority.ts';
const HANDOFF_MODULE = 'src/coordinator/handoff.ts';

type ProductionSource = {
  readonly file: string;
  readonly sourceFile: ts.SourceFile;
};

type SourceViolation = {
  readonly file: string;
  readonly rule: string;
};

type SourceFacts = {
  readonly assignments: ReadonlyMap<string, readonly ts.Expression[]>;
  readonly authorityDerivations: readonly ts.CallExpression[];
  readonly startupRecoveryCalls: readonly ts.CallExpression[];
};

const PRODUCTION_SOURCES: readonly ProductionSource[] = listProductionSourceFiles(SRC_ROOT).map((filePath) => {
  const file = relative(REPO_ROOT, filePath).replaceAll('\\', '/');
  return {
    file,
    sourceFile: ts.createSourceFile(file, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true),
  };
});

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function calledName(call: ts.CallExpression): string | null {
  const expression = unwrapExpression(call.expression);
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current) ||
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

function localTypeNames(sourceFile: ts.SourceFile, exportedName: string): ReadonlySet<string> {
  const names = new Set([exportedName]);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) {
      continue;
    }
    if (!ts.isNamedImports(statement.importClause.namedBindings)) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === exportedName) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function assertedTypeName(node: ts.AsExpression | ts.TypeAssertion): string | null {
  if (ts.isTypeReferenceNode(node.type)) {
    const typeName = node.type.typeName;
    return ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;
  }
  return null;
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return current.name && ts.isIdentifier(current.name) ? current.name.text : null;
    }
  }
  return null;
}

function addAssignment(assignments: Map<string, ts.Expression[]>, name: string, expression: ts.Expression): void {
  const values = assignments.get(name) ?? [];
  values.push(expression);
  assignments.set(name, values);
}

function collectSourceFacts(source: ProductionSource, violations: SourceViolation[]): SourceFacts {
  const assignments = new Map<string, ts.Expression[]>();
  const authorityDerivations: ts.CallExpression[] = [];
  const startupRecoveryCalls: ts.CallExpression[] = [];
  const authorityTypeNames = localTypeNames(source.sourceFile, 'BoundCoordinatorAuthority');
  const successfulBindTypeNames = localTypeNames(source.sourceFile, 'SuccessfulCoordinatorBindResult');

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      addAssignment(assignments, node.name.text, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      addAssignment(assignments, node.left.text, node.right);
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      if (name === 'boundCoordinatorAuthorityFrom') {
        authorityDerivations.push(node);
      } else if (name === 'runStartupRecoveryFn') {
        startupRecoveryCalls.push(node);
      }
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const typeName = assertedTypeName(node);
      if (
        typeName !== null &&
        authorityTypeNames.has(typeName) &&
        (source.file !== AUTHORITY_MODULE || enclosingFunctionName(node) !== 'boundCoordinatorAuthorityFrom')
      ) {
        violations.push({ file: source.file, rule: 'bind authority may only be asserted inside its issuer' });
      }
      if (
        typeName !== null &&
        successfulBindTypeNames.has(typeName) &&
        (source.file !== HANDOFF_MODULE || enclosingFunctionName(node) !== 'bindWithHandoff')
      ) {
        violations.push({ file: source.file, rule: 'successful bind results may only be asserted by bindWithHandoff' });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source.sourceFile);
  return { assignments, authorityDerivations, startupRecoveryCalls };
}

function expressionComesFromCall(
  expression: ts.Expression,
  callName: string,
  assignments: ReadonlyMap<string, readonly ts.Expression[]>,
  seen: Set<string> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isCallExpression(unwrapped)) {
    return calledName(unwrapped) === callName;
  }
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) {
    return false;
  }

  seen.add(unwrapped.text);
  const hasOrigin = (assignments.get(unwrapped.text) ?? []).some((assigned) =>
    expressionComesFromCall(assigned, callName, assignments, seen),
  );
  seen.delete(unwrapped.text);
  return hasOrigin;
}

function expressionComesFromSuccessfulBindAuthority(
  expression: ts.Expression,
  assignments: ReadonlyMap<string, readonly ts.Expression[]>,
  seen: Set<string> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isCallExpression(unwrapped) && calledName(unwrapped) === 'boundCoordinatorAuthorityFrom') {
    const bindResult = unwrapped.arguments[0];
    return bindResult !== undefined && expressionComesFromCall(bindResult, 'bindWithHandoff', assignments);
  }
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) {
    return false;
  }

  seen.add(unwrapped.text);
  const hasOrigin = (assignments.get(unwrapped.text) ?? []).some((assigned) =>
    expressionComesFromSuccessfulBindAuthority(assigned, assignments, seen),
  );
  seen.delete(unwrapped.text);
  return hasOrigin;
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}

function startupRecoveryAuthority(call: ts.CallExpression): ts.Expression | null {
  const argument = call.arguments[0];
  if (argument === undefined) {
    return null;
  }
  const object = unwrapExpression(argument);
  if (!ts.isObjectLiteralExpression(object)) {
    return null;
  }

  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'boundCoordinatorAuthority') {
      return property.name;
    }
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'boundCoordinatorAuthority') {
      return property.initializer;
    }
  }
  return null;
}

function scanProductionSources(): SourceViolation[] {
  const violations: SourceViolation[] = [];
  let authorityDerivations = 0;
  let startupRecoveryCalls = 0;

  for (const source of PRODUCTION_SOURCES) {
    const facts = collectSourceFacts(source, violations);
    authorityDerivations += facts.authorityDerivations.length;
    startupRecoveryCalls += facts.startupRecoveryCalls.length;

    for (const derivation of facts.authorityDerivations) {
      const bindResult = derivation.arguments[0];
      if (bindResult === undefined || !expressionComesFromCall(bindResult, 'bindWithHandoff', facts.assignments)) {
        violations.push({ file: source.file, rule: 'bind authority must be derived from a successful bind result' });
      }
    }

    for (const call of facts.startupRecoveryCalls) {
      const authority = startupRecoveryAuthority(call);
      if (authority === null || !expressionComesFromSuccessfulBindAuthority(authority, facts.assignments)) {
        violations.push({ file: source.file, rule: 'startup recovery must receive authority obtained from bind' });
      }
    }
  }

  if (authorityDerivations === 0) {
    violations.push({ file: 'src/**', rule: 'no successful bind result is converted to bind authority' });
  }
  if (startupRecoveryCalls === 0) {
    violations.push({ file: 'src/**', rule: 'no startup recovery call is protected by bind authority' });
  }
  return violations;
}

function brandViolation(modulePath: string, brandName: string, interfaceName: string): SourceViolation[] {
  const source = PRODUCTION_SOURCES.find((candidate) => candidate.file === modulePath);
  if (source === undefined) {
    return [{ file: modulePath, rule: 'brand owner module is missing' }];
  }

  let declaration: ts.VariableDeclaration | null = null;
  let declarationStatement: ts.VariableStatement | null = null;
  let brandedInterface: ts.InterfaceDeclaration | null = null;
  let separatelyExported = false;

  for (const statement of source.sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const candidate of statement.declarationList.declarations) {
        if (ts.isIdentifier(candidate.name) && candidate.name.text === brandName) {
          declaration = candidate;
          declarationStatement = statement;
        }
      }
    } else if (ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName) {
      brandedInterface = statement;
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      separatelyExported ||= statement.exportClause.elements.some(
        (element) => (element.propertyName ?? element.name).text === brandName,
      );
    }
  }

  const violations: SourceViolation[] = [];
  const isUniqueSymbol =
    declaration?.type !== undefined &&
    ts.isTypeOperatorNode(declaration.type) &&
    declaration.type.operator === ts.SyntaxKind.UniqueKeyword &&
    declaration.type.type.kind === ts.SyntaxKind.SymbolKeyword;
  const isPrivateDeclaration =
    declarationStatement !== null &&
    hasModifier(declarationStatement, ts.SyntaxKind.DeclareKeyword) &&
    !hasModifier(declarationStatement, ts.SyntaxKind.ExportKeyword) &&
    !separatelyExported &&
    (declarationStatement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  if (!isUniqueSymbol || !isPrivateDeclaration) {
    violations.push({ file: modulePath, rule: `${brandName} must remain a module-private declared unique symbol` });
  }

  const interfaceUsesPrivateBrand = brandedInterface?.members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name !== undefined &&
      ts.isComputedPropertyName(member.name) &&
      ts.isIdentifier(member.name.expression) &&
      member.name.expression.text === brandName,
  );
  if (interfaceUsesPrivateBrand !== true) {
    violations.push({ file: modulePath, rule: `${interfaceName} must carry its module-private brand` });
  }
  return violations;
}

describe('coordinator-bind-authority', () => {
  it('should keep every startup recovery entry behind successful bind authority', () => {
    expect(scanProductionSources()).toEqual([]);
  });

  it('should keep bind authority brands private', () => {
    expect([
      ...brandViolation(AUTHORITY_MODULE, 'boundCoordinatorAuthorityBrand', 'BoundCoordinatorAuthority'),
      ...brandViolation(HANDOFF_MODULE, 'successfulCoordinatorBindResultBrand', 'SuccessfulCoordinatorBindResult'),
    ]).toEqual([]);
  });
});
