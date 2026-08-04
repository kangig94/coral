import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const RUNNER_MODULE = 'src/coordinator/handoff-runner.ts';
const TARGET_MODULE = 'src/infra/handoff-target.ts';

type ProductionSource = Readonly<{
  file: string;
  sourceFile: ts.SourceFile;
}>;

function productionSources(): ProductionSource[] {
  return listProductionSourceFiles(resolve(REPO_ROOT, 'src')).map((filePath) => {
    const file = relative(REPO_ROOT, filePath).replaceAll('\\', '/');
    return {
      file,
      sourceFile: ts.createSourceFile(file, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true),
    };
  });
}

function resolveImport(source: ProductionSource, specifier: string): string {
  if (!specifier.startsWith('.')) {
    return specifier;
  }
  const sourcePath = resolve(REPO_ROOT, source.file);
  const imported = resolve(dirname(sourcePath), specifier);
  const typescriptPath = imported.endsWith('.js') ? `${imported.slice(0, -3)}.ts` : imported;
  return relative(REPO_ROOT, typescriptPath).replaceAll('\\', '/');
}

function importedName(element: ts.ImportSpecifier): string {
  return (element.propertyName ?? element.name).text;
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

function variableAssignments(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const assignments = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      assignments.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return assignments;
}

function expressionUsesBundleDir(
  expression: ts.Expression,
  assignments: ReadonlyMap<string, ts.Expression>,
  seen: Set<string> = new Set(),
): boolean {
  let usesBundleDir = false;
  const visit = (node: ts.Node): void => {
    if (usesBundleDir) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'bundleDir') {
      usesBundleDir = true;
      return;
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const assignment = assignments.get(node.text);
      if (assignment !== undefined) {
        seen.add(node.text);
        usesBundleDir = expressionUsesBundleDir(assignment, assignments, seen);
        seen.delete(node.text);
        if (usesBundleDir) return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return usesBundleDir;
}

function enclosingFunctionNamed(node: ts.Node, name: string): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === name) {
      return true;
    }
  }
  return false;
}

function containingStatement(node: ts.Node): ts.Statement | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isStatement(current)) return current;
  }
  return null;
}

function immediatelyFollowsExecutableAssertion(call: ts.CallExpression): boolean {
  const statement = containingStatement(call);
  if (statement === null || statement.parent === undefined || !ts.isBlock(statement.parent)) {
    return false;
  }
  const statements = statement.parent.statements;
  const index = statements.indexOf(statement);
  if (index < 1) return false;
  const previous = statements[index - 1];
  if (!ts.isExpressionStatement(previous)) return false;
  const expression = unwrapExpression(previous.expression);
  const called = ts.isCallExpression(expression) ? unwrapExpression(expression.expression) : null;
  return (
    ts.isCallExpression(expression) &&
    called !== null &&
    ts.isPropertyAccessExpression(called) &&
    called.name.text === 'assertExecutable' &&
    expression.arguments.length === 0
  );
}

function resolveObjectLiteral(
  expression: ts.Expression,
  assignments: ReadonlyMap<string, ts.Expression>,
): ts.ObjectLiteralExpression | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (!ts.isIdentifier(unwrapped)) return null;
  const assigned = assignments.get(unwrapped.text);
  return assigned === undefined ? null : resolveObjectLiteral(assigned, assignments);
}

function hasInheritedStdio(
  expression: ts.Expression | undefined,
  assignments: ReadonlyMap<string, ts.Expression>,
): boolean {
  if (expression === undefined) return false;
  const options = resolveObjectLiteral(expression, assignments);
  return (
    options?.properties.some((property) => {
      if (
        !ts.isPropertyAssignment(property) ||
        !(
          (ts.isIdentifier(property.name) && property.name.text === 'stdio') ||
          (ts.isStringLiteral(property.name) && property.name.text === 'stdio')
        )
      ) {
        return false;
      }
      const value = unwrapExpression(property.initializer);
      return ts.isStringLiteral(value) && value.text === 'inherit';
    }) === true
  );
}

function isProcessExecPath(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return false;
  const unwrapped = unwrapExpression(expression);
  const owner = ts.isPropertyAccessExpression(unwrapped) ? unwrapExpression(unwrapped.expression) : null;
  return (
    ts.isPropertyAccessExpression(unwrapped) &&
    owner !== null &&
    ts.isIdentifier(owner) &&
    owner.text === 'process' &&
    unwrapped.name.text === 'execPath'
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

function isValidatorType(typeNode: ts.TypeNode | undefined, validatorTypeBindings: ReadonlySet<string>): boolean {
  return (
    typeNode !== undefined &&
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    validatorTypeBindings.has(typeNode.typeName.text)
  );
}

function initializedFromValidatorConstructor(
  expression: ts.Expression | undefined,
  constructorBindings: ReadonlySet<string>,
): boolean {
  if (expression === undefined) return false;
  const unwrapped = unwrapExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return false;
  const called = unwrapExpression(unwrapped.expression);
  return ts.isIdentifier(called) && constructorBindings.has(called.text);
}

function scanHandoffExecutionSources(sources: readonly ProductionSource[]): string[] {
  const violations: string[] = [];
  const executionMethodNames = new Set(['exec', 'execFile', 'fork', 'spawn']);
  let constructorImports = 0;
  let runnerBoundaryImports = 0;
  let runnerSpawnCalls = 0;

  for (const source of sources) {
    const assignments = variableAssignments(source.sourceFile);
    const spawnBindings = new Set<string>();
    const childProcessNamespaces = new Set<string>();
    const constructorBindings = new Set<string>();
    const validatorTypeBindings = new Set<string>();
    const validatorValues = new Set<string>();

    for (const statement of source.sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveImport(source, statement.moduleSpecifier.text);
        const clause = statement.importClause;
        if (target === 'node:child_process' && clause?.namedBindings !== undefined) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              if (!element.isTypeOnly && importedName(element) === 'spawn') {
                spawnBindings.add(element.name.text);
              }
            }
          } else if (!clause.isTypeOnly) {
            childProcessNamespaces.add(clause.namedBindings.name.text);
          }
        }

        if (target !== TARGET_MODULE || clause?.isTypeOnly === true || clause === undefined) {
          continue;
        }
        if (clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) {
          if (source.file !== RUNNER_MODULE) {
            violations.push(`${source.file}: foreign-target authority namespace import`);
          }
          continue;
        }
        for (const element of clause.namedBindings.elements) {
          if (importedName(element) === 'ForeignTargetValidator') {
            validatorTypeBindings.add(element.name.text);
          }
          if (element.isTypeOnly) continue;
          if (importedName(element) === 'createForeignTargetValidator') {
            constructorBindings.add(element.name.text);
            constructorImports += 1;
            if (source.file !== RUNNER_MODULE) {
              violations.push(`${source.file}: foreign-validator constructor import`);
            }
          }
          if (importedName(element) === 'withValidatedHandoffTarget') {
            runnerBoundaryImports += 1;
            if (source.file !== RUNNER_MODULE) {
              violations.push(`${source.file}: validated-target execution boundary import`);
            }
          }
        }
      }

      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        resolveImport(source, statement.moduleSpecifier.text) === TARGET_MODULE
      ) {
        const names =
          statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements.map((element) => (element.propertyName ?? element.name).text)
            : ['createForeignTargetValidator'];
        if (names.includes('createForeignTargetValidator')) {
          violations.push(`${source.file}: foreign-validator constructor re-export`);
        }
      }
    }

    for (const statement of source.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            (isValidatorType(declaration.type, validatorTypeBindings) ||
              initializedFromValidatorConstructor(declaration.initializer, constructorBindings))
          ) {
            validatorValues.add(declaration.name.text);
            if (hasExportModifier(statement)) {
              violations.push(`${source.file}: foreign-validator capability export`);
            }
          }
        }
      }
      if (
        ts.isFunctionDeclaration(statement) &&
        hasExportModifier(statement) &&
        isValidatorType(statement.type, validatorTypeBindings)
      ) {
        violations.push(`${source.file}: foreign-validator capability export`);
      }
    }

    for (const statement of source.sourceFile.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier === undefined &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          if (validatorValues.has((element.propertyName ?? element.name).text)) {
            violations.push(`${source.file}: foreign-validator capability export`);
          }
        }
      }
      if (
        ts.isExportAssignment(statement) &&
        ts.isIdentifier(unwrapExpression(statement.expression)) &&
        validatorValues.has((unwrapExpression(statement.expression) as ts.Identifier).text)
      ) {
        violations.push(`${source.file}: foreign-validator capability export`);
      }
    }

    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }

      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0]) &&
        resolveImport(source, node.arguments[0].text) === TARGET_MODULE &&
        source.file !== RUNNER_MODULE
      ) {
        violations.push(`${source.file}: foreign-target authority dynamic import`);
      }

      const called = unwrapExpression(node.expression);
      const calledOwner = ts.isPropertyAccessExpression(called) ? unwrapExpression(called.expression) : null;
      const calledName = ts.isIdentifier(called)
        ? spawnBindings.has(called.text)
          ? 'spawn'
          : called.text
        : ts.isPropertyAccessExpression(called)
          ? called.name.text
          : null;
      const isSpawn =
        (ts.isIdentifier(called) && spawnBindings.has(called.text)) ||
        (ts.isPropertyAccessExpression(called) &&
          calledOwner !== null &&
          ts.isIdentifier(calledOwner) &&
          childProcessNamespaces.has(calledOwner.text) &&
          called.name.text === 'spawn');
      const isForeignExecution =
        calledName !== null &&
        executionMethodNames.has(calledName) &&
        node.arguments.some((argument) => expressionUsesBundleDir(argument, assignments));
      if (isForeignExecution && source.file !== RUNNER_MODULE) {
        violations.push(`${source.file}: foreign bundle spawn outside handoff runner`);
      }
      if (isForeignExecution && source.file === RUNNER_MODULE && !isSpawn) {
        violations.push(`${source.file}: foreign bundle execution is not the exact authorized spawn`);
      }
      if (isSpawn && source.file === RUNNER_MODULE) {
        runnerSpawnCalls += 1;
        if (
          !isForeignExecution ||
          !enclosingFunctionNamed(node, 'runHandoff') ||
          !immediatelyFollowsExecutableAssertion(node) ||
          !isProcessExecPath(node.arguments[0]) ||
          !hasInheritedStdio(node.arguments[2], assignments)
        ) {
          violations.push(`${source.file}: foreign bundle spawn is not the exact authorized site`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.sourceFile);
  }

  if (constructorImports !== 1) {
    violations.push(`expected one foreign-validator constructor import, found ${constructorImports}`);
  }
  if (runnerBoundaryImports !== 1) {
    violations.push(`expected one validated-target execution boundary import, found ${runnerBoundaryImports}`);
  }
  if (runnerSpawnCalls !== 1) {
    violations.push(`expected one handoff-runner spawn site, found ${runnerSpawnCalls}`);
  }
  return violations;
}

describe('handoff execution authority invariants', () => {
  it('should keep the foreign validator and executable spawn at the sole authorized production site', () => {
    expect(scanHandoffExecutionSources(productionSources())).toEqual([]);
  });

  it('should reject a foreign-validator constructor import outside the runner', () => {
    const mutation = ts.createSourceFile(
      'src/coordinator/rogue-validator.ts',
      `import { createForeignTargetValidator } from '../infra/handoff-target.js';\nvoid createForeignTargetValidator;`,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(
      scanHandoffExecutionSources([
        ...productionSources(),
        { file: 'src/coordinator/rogue-validator.ts', sourceFile: mutation },
      ]),
    ).toContain('src/coordinator/rogue-validator.ts: foreign-validator constructor import');
  });

  it('should reject an exported foreign-validator capability', () => {
    const mutation = ts.createSourceFile(
      RUNNER_MODULE,
      [
        `import { createForeignTargetValidator, type ForeignTargetValidator } from '../infra/handoff-target.js';`,
        `export const leakedValidator: ForeignTargetValidator = createForeignTargetValidator();`,
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );

    const sources = productionSources().filter((source) => source.file !== RUNNER_MODULE);
    expect(scanHandoffExecutionSources([...sources, { file: RUNNER_MODULE, sourceFile: mutation }])).toContain(
      `${RUNNER_MODULE}: foreign-validator capability export`,
    );
  });

  it('should reject a second foreign bundle spawn site', () => {
    const mutation = ts.createSourceFile(
      'src/coordinator/rogue-spawn.ts',
      [
        `import { spawn } from 'node:child_process';`,
        `import { join } from 'node:path';`,
        `import { withValidatedHandoffTarget, type ValidatedHandoffTarget } from '../infra/handoff-target.js';`,
        `export function rogue(target: ValidatedHandoffTarget): void {`,
        `  const execution = withValidatedHandoffTarget(target);`,
        `  execution.assertExecutable();`,
        `  spawn(process.execPath, [join(execution.bundleDir, 'coral-cli.cjs')], { stdio: 'inherit' });`,
        `}`,
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );

    const violations = scanHandoffExecutionSources([
      ...productionSources(),
      { file: 'src/coordinator/rogue-spawn.ts', sourceFile: mutation },
    ]);
    expect(violations).toContain('src/coordinator/rogue-spawn.ts: validated-target execution boundary import');
    expect(violations).toContain('src/coordinator/rogue-spawn.ts: foreign bundle spawn outside handoff runner');
  });
});
