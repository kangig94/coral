import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIMULATION_CLI = resolve(REPO_ROOT, 'tools/simulation/cli.ts');

function couldExecuteAtTopLevel(statement: ts.Statement): boolean {
  return !(
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isEmptyStatement(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isFunctionDeclaration(statement)
  );
}

function isSimulationTierStamp(statement: ts.Statement | undefined): boolean {
  if (statement === undefined || !ts.isExpressionStatement(statement)) return false;
  let assignment: ts.Expression = statement.expression;
  while (ts.isParenthesizedExpression(assignment)) assignment = assignment.expression;
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return false;
  }
  if (!ts.isStringLiteralLike(assignment.right) || assignment.right.text !== 'simulation') return false;

  const tier = assignment.left;
  if (!ts.isPropertyAccessExpression(tier) || tier.name.text !== 'CORAL_TEST_TIER') return false;
  const env = tier.expression;
  return (
    ts.isPropertyAccessExpression(env) &&
    env.name.text === 'env' &&
    ts.isIdentifier(env.expression) &&
    env.expression.text === 'process'
  );
}

function invokesSimulationCli(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isVoidExpression(statement.expression)) return false;
  const invocation = statement.expression.expression;
  return (
    ts.isCallExpression(invocation) &&
    ts.isIdentifier(invocation.expression) &&
    invocation.expression.text === 'runSimulationCli' &&
    invocation.arguments.length === 0
  );
}

describe('standalone simulation tier', () => {
  it('establishes the simulation tier before entry-point work', () => {
    const source = ts.createSourceFile(
      SIMULATION_CLI,
      readFileSync(SIMULATION_CLI, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const firstExecutableStatement = source.statements.find(couldExecuteAtTopLevel);

    expect(isSimulationTierStamp(firstExecutableStatement)).toBe(true);
    expect(source.statements.some(invokesSimulationCli)).toBe(true);
  });
});
