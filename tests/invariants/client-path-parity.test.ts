import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { storePaths } from '#src/infra/path/store.js';

const REPO_ROOT = process.cwd();
const HOME_DIR = join(REPO_ROOT, '.client-path-parity-home');
const STATE_ROOT = join(HOME_DIR, '.coral');
const FLAVORS = ['prod', 'dev'] as const;

type MirrorValue = string | boolean;

function evaluateMirrorExpression(expression: ts.Expression, scope: ReadonlyMap<string, MirrorValue>): MirrorValue {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    const value = scope.get(expression.text);
    if (value !== undefined) return value;
  }
  if (ts.isParenthesizedExpression(expression)) return evaluateMirrorExpression(expression.expression, scope);
  if (ts.isConditionalExpression(expression)) {
    return evaluateMirrorExpression(expression.condition, scope)
      ? evaluateMirrorExpression(expression.whenTrue, scope)
      : evaluateMirrorExpression(expression.whenFalse, scope);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return evaluateMirrorExpression(expression.left, scope) === evaluateMirrorExpression(expression.right, scope);
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'join'
  ) {
    const segments = expression.arguments.map((argument) => evaluateMirrorExpression(argument, scope));
    if (segments.every((segment): segment is string => typeof segment === 'string')) return join(...segments);
  }
  throw new Error(`Unsupported client path expression: ${expression.getText()}`);
}

function loadMirrorFunction<T extends (...args: never[]) => string>(relativePath: string, name: string): T {
  const filePath = join(REPO_ROOT, relativePath);
  const sourceText = readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );

  if (!declaration) throw new Error(`Missing ${name} in ${relativePath}`);

  // Hook entry points execute on import and may consume stdin or exit. Evaluate
  // only the narrow path-expression subset in the exact declaration production calls.
  return ((...args: string[]): string => {
    const scope = new Map<string, MirrorValue>();
    declaration.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) throw new Error(`Unsupported parameter in ${relativePath}`);
      scope.set(parameter.name.text, args[index]);
    });

    for (const statement of declaration.body?.statements ?? []) {
      if (ts.isVariableStatement(statement)) {
        for (const variable of statement.declarationList.declarations) {
          if (!ts.isIdentifier(variable.name) || !variable.initializer) {
            throw new Error(`Unsupported variable declaration in ${relativePath}`);
          }
          scope.set(variable.name.text, evaluateMirrorExpression(variable.initializer, scope));
        }
      }
      if (ts.isReturnStatement(statement) && statement.expression) {
        const value = evaluateMirrorExpression(statement.expression, scope);
        if (typeof value === 'string') return value;
      }
    }

    throw new Error(`Missing string return from ${name} in ${relativePath}`);
  }) as unknown as T;
}

const mirroredStoreDbPath = loadMirrorFunction<(flavor: BuildFlavor, stateRoot: string) => string>(
  'clients/hooks/pre-compact.mjs',
  'storeDbPath',
);
const mirroredCoordinatorRunDir = loadMirrorFunction<(flavor: BuildFlavor, stateRoot: string) => string>(
  'clients/hooks/session-start.mjs',
  'coordinatorRunDir',
);
const mirroredEngineBinaryPath = loadMirrorFunction<
  (id: string, bin: string, flavor: BuildFlavor, stateRoot: string) => string
>('clients/hooks/lib/equip-tools.mjs', 'engineBinaryPath');
const mirroredCoordinatorInfoPath = loadMirrorFunction<(homeDir: string, flavor: BuildFlavor) => string>(
  'clients/skills/statusline/coral-hud.mjs',
  'coralBackendInfoPath',
);

describe('self-contained client path parity', () => {
  it.each(FLAVORS)('matches authoritative %s paths', (flavor) => {
    const opts = { baseDir: STATE_ROOT };
    const store = storePaths(flavor, opts);
    const engine = enginePaths(flavor, opts);
    const coordinator = coordinatorPaths(flavor, {}, opts);

    expect(mirroredStoreDbPath(flavor, STATE_ROOT)).toBe(store.dbFile);

    const runDir = mirroredCoordinatorRunDir(flavor, STATE_ROOT);
    expect(runDir).toBe(coordinator.runDir);
    expect(join(runDir, 'coordinator.log')).toBe(join(coordinator.runDir, 'coordinator.log'));

    expect(mirroredEngineBinaryPath('codebase-memory', 'codebase-memory-mcp', flavor, STATE_ROOT)).toBe(
      join(engine.dataDir('codebase-memory'), 'codebase-memory-mcp'),
    );
    expect(mirroredCoordinatorInfoPath(HOME_DIR, flavor)).toBe(coordinator.infoFile);
  });
});
