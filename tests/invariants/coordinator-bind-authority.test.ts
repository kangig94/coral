import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const HANDOFF_MODULE = 'src/coordinator/handoff.ts';

type ProductionSource = Readonly<{
  file: string;
  sourceFile: ts.SourceFile;
}>;

function productionSources(): ProductionSource[] {
  return listProductionSourceFiles(resolve(REPO_ROOT, 'src')).map((filePath) => ({
    file: relative(REPO_ROOT, filePath).replaceAll('\\', '/'),
    sourceFile: ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true),
  }));
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}

const MARKER_PROPERTIES = ['acquiredViaHandoff', 'runStartupRecovery'] as const;

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

/** Follows a spread's identifier chain to the object literal it was assigned from, if any. */
function resolveSpreadObjectLiteral(
  expression: ts.Expression,
  assignments: ReadonlyMap<string, ts.Expression>,
  seen: Set<string> = new Set(),
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) {
    return null;
  }
  const assigned = assignments.get(expression.text);
  if (assigned === undefined) {
    return null;
  }
  seen.add(expression.text);
  return resolveSpreadObjectLiteral(assigned, assignments, seen);
}

type ObjectLiteralShape = { names: ReadonlySet<string>; hasUnresolvedSpread: boolean };

/**
 * Collects the property names an object literal is known to carry, following
 * any spread whose source resolves to another statically-known literal. A
 * `SpreadAssignment` contributing nothing on unresolved (the original bug)
 * makes `{ ...partial, runStartupRecovery: fn }` invisible whenever `partial`
 * is the one that would have carried `acquiredViaHandoff` — the shape reads
 * as "only one marker property" and slips under the two-marker requirement.
 * `hasUnresolvedSpread` lets the caller refuse to clear a literal it could
 * not fully account for, instead of silently treating unresolved as absent.
 */
function objectLiteralShape(
  node: ts.ObjectLiteralExpression,
  assignments: ReadonlyMap<string, ts.Expression>,
): ObjectLiteralShape {
  const names = new Set<string>();
  let hasUnresolvedSpread = false;

  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.add(property.name.text);
      continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = propertyNameText(property.name);
      if (name !== null) names.add(name);
      continue;
    }
    if (!ts.isSpreadAssignment(property)) {
      continue;
    }
    const resolved = resolveSpreadObjectLiteral(property.expression, assignments);
    if (resolved === null) {
      hasUnresolvedSpread = true;
      continue;
    }
    const nested = objectLiteralShape(resolved, assignments);
    for (const name of nested.names) names.add(name);
    hasUnresolvedSpread ||= nested.hasUnresolvedSpread;
  }

  return { names, hasUnresolvedSpread };
}

function scanBoundCoordinatorOwners(sources: readonly ProductionSource[]): string[] {
  const owners: string[] = [];
  const unresolved: string[] = [];
  for (const source of sources) {
    const assignments = variableAssignments(source.sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const { names, hasUnresolvedSpread } = objectLiteralShape(node, assignments);
        const markerCount = MARKER_PROPERTIES.filter((marker) => names.has(marker)).length;
        if (markerCount === MARKER_PROPERTIES.length) {
          owners.push(source.file);
        } else if (hasUnresolvedSpread && markerCount > 0) {
          // At least one marker is present outright and a spread could carry
          // the rest — cannot rule this out as a second construction site,
          // so this fails loudly instead of passing as "not a match".
          unresolved.push(source.file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.sourceFile);
  }

  if (unresolved.length > 0) {
    return unresolved.map(
      (file) =>
        `${file}: object literal spreads an unresolved expression alongside a bound-coordinator marker property — cannot verify it does not construct a second bound coordinator`,
    );
  }

  if (owners.length !== 1) {
    return [`expected one bound coordinator construction site, found ${owners.length}`];
  }
  return owners[0] === HANDOFF_MODULE ? [] : [`${owners[0]}: bound coordinator constructed outside handoff owner`];
}

describe('coordinator-bind-authority', () => {
  it('should keep the bound coordinator capability at one production construction site', () => {
    expect(scanBoundCoordinatorOwners(productionSources())).toEqual([]);
  });

  it('should reject a second bound coordinator construction site', () => {
    const rogue = ts.createSourceFile(
      'src/coordinator/rogue-bound-coordinator.ts',
      `const forged = { acquiredViaHandoff: false, runStartupRecovery: async () => [] }; void forged;`,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(
      scanBoundCoordinatorOwners([
        ...productionSources(),
        { file: 'src/coordinator/rogue-bound-coordinator.ts', sourceFile: rogue },
      ]),
    ).toEqual(['expected one bound coordinator construction site, found 2']);
  });

  it('should reject a second construction site hidden behind an unresolvable spread', () => {
    // `partial` is a function parameter, not a local literal — its contents
    // are not statically knowable, so the object literal could be spreading
    // in `acquiredViaHandoff` alongside the `runStartupRecovery` it carries
    // outright. Silently reading this as "only one marker, not a match"
    // (the pre-fix behavior) is exactly what let a second site hide.
    const rogue = ts.createSourceFile(
      'src/coordinator/rogue-bound-coordinator-spread.ts',
      `function forge(partial: object) { return { ...partial, runStartupRecovery: async () => [] }; }\nvoid forge;`,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(
      scanBoundCoordinatorOwners([
        ...productionSources(),
        { file: 'src/coordinator/rogue-bound-coordinator-spread.ts', sourceFile: rogue },
      ]),
    ).toEqual([
      'src/coordinator/rogue-bound-coordinator-spread.ts: object literal spreads an unresolved expression alongside a bound-coordinator marker property — cannot verify it does not construct a second bound coordinator',
    ]);
  });

  it('resolves a spread of a local literal instead of flagging it as unresolvable', () => {
    // `base` is a locally-assigned object literal, so its contents ARE
    // statically knowable — the spread should resolve and this should be
    // treated as a normal (matching) construction site, not an ambiguous one.
    const resolvable = ts.createSourceFile(
      'src/coordinator/resolvable-spread.ts',
      [
        'const base = { acquiredViaHandoff: false };',
        'const forged = { ...base, runStartupRecovery: async () => [] };',
        'void forged;',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );

    expect(
      scanBoundCoordinatorOwners([
        ...productionSources(),
        { file: 'src/coordinator/resolvable-spread.ts', sourceFile: resolvable },
      ]),
    ).toEqual(['expected one bound coordinator construction site, found 2']);
  });
});
