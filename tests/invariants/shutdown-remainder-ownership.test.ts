import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OWNERSHIP_SCAN_ROOT = 'src';
const SHUTDOWN_PATH = 'src/coordinator/shutdown.ts';
const SHUTDOWN_SETTLEMENT_PATH = 'src/coordinator/shutdown-settlement.ts';
const PROCESS_EXIT_OBLIGATION_INVENTORY = [
  'recovery coordinator teardown',
  'kb child shutdown',
  'provider operation mutation drain',
  'provider host shutdown',
  'pending launch settlement',
  'app-server handoff quiesce',
  'provider host drain for handoff',
  'process incarnation probe shutdown',
  'lifecycle reactor dispose',
  'store epoch sweep cancellation',
] as const;
const DERIVED_REMAINDER_OBLIGATIONS: Readonly<Record<string, string>> = {
  'child termination': 'childTerminationRemainder',
};

function sourceFile(canonicalPath: string): ts.SourceFile {
  return ts.createSourceFile(
    canonicalPath,
    readFileSync(join(REPO_ROOT, canonicalPath), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function sourceFiles(canonicalDirectory: string): ts.SourceFile[] {
  return readdirSync(join(REPO_ROOT, canonicalDirectory), { withFileTypes: true }).flatMap((entry) => {
    const canonicalPath = `${canonicalDirectory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(canonicalPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [sourceFile(canonicalPath)] : [];
  });
}

function propertyName(property: ts.ObjectLiteralElementLike | ts.TypeElement): string | null {
  if (!('name' in property) || property.name === undefined) return null;
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
}

function propertyAssignment(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function remainderThunkBody(initializer: ts.Expression): ts.Expression | null {
  const thunk = unwrapExpression(initializer);
  if (!ts.isArrowFunction(thunk) || thunk.parameters.length !== 0 || ts.isBlock(thunk.body)) return null;
  return unwrapExpression(thunk.body);
}

function ownerLiteral(property: ts.PropertyAssignment | ts.PropertySignature): string | null {
  if (ts.isPropertyAssignment(property)) {
    const initializer = unwrapExpression(property.initializer);
    return ts.isStringLiteral(initializer) ? initializer.text : null;
  }
  return property.type !== undefined && ts.isLiteralTypeNode(property.type) && ts.isStringLiteral(property.type.literal)
    ? property.type.literal.text
    : null;
}

function location(node: ts.Node): string {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `${file.fileName}:${line + 1}`;
}

function processExitInventoryViolations(): string[] {
  const shutdown = sourceFile(SHUTDOWN_PATH);
  const settlement = sourceFile(SHUTDOWN_SETTLEMENT_PATH);
  const expected = new Set<string>(PROCESS_EXIT_OBLIGATION_INVENTORY);
  const found = new Map<string, number>();
  const violations: string[] = [];

  function inspectProcessExitOwner(site: string, initializer: ts.Expression, node: ts.Node): void {
    if (!ts.isObjectLiteralExpression(initializer)) {
      violations.push(`${location(node)} ${site} must declare its remainder owner as an object literal`);
      return;
    }
    const owner = propertyAssignment(initializer, 'owner');
    if (owner === undefined || ownerLiteral(owner) !== 'process-exit') {
      violations.push(`${location(node)} ${site} must assign remainder owner 'process-exit'`);
    }
  }

  function inspectDerivedRemainder(name: string, initializer: ts.Expression, node: ts.Node): void {
    const body = remainderThunkBody(initializer);
    const derivation = DERIVED_REMAINDER_OBLIGATIONS[name];
    if (
      body === null ||
      !ts.isCallExpression(body) ||
      !ts.isIdentifier(body.expression) ||
      body.expression.text !== derivation
    ) {
      violations.push(
        `${location(node)} shutdown obligation '${name}' must derive its remainder through ${derivation}`,
      );
    }
  }

  function visitShutdown(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const label = propertyAssignment(node, 'label');
      const name = label !== undefined && ts.isStringLiteral(label.initializer) ? label.initializer.text : null;
      if (name !== null && (expected.has(name) || name in DERIVED_REMAINDER_OBLIGATIONS)) {
        found.set(name, (found.get(name) ?? 0) + 1);
        const remainder = propertyAssignment(node, 'remainder');
        if (remainder === undefined) {
          violations.push(`${location(node)} shutdown obligation '${name}' must declare a remainder owner`);
        } else if (name in DERIVED_REMAINDER_OBLIGATIONS) {
          inspectDerivedRemainder(name, remainder.initializer, remainder);
        } else {
          const body = remainderThunkBody(remainder.initializer);
          if (body === null) {
            violations.push(
              `${location(remainder)} shutdown obligation '${name}' must declare its remainder as a thunk`,
            );
          } else {
            inspectProcessExitOwner(`shutdown obligation '${name}'`, body, remainder);
          }
        }
      }
    }
    ts.forEachChild(node, visitShutdown);
  }
  visitShutdown(shutdown);

  for (const name of [...expected, ...Object.keys(DERIVED_REMAINDER_OBLIGATIONS)]) {
    const count = found.get(name) ?? 0;
    if (count !== 1) {
      violations.push(
        `${SHUTDOWN_PATH} must contain exactly one ownership-inventory obligation '${name}'; found ${count}`,
      );
    }
  }

  const boundaries: ts.PropertyAssignment[] = [];
  function visitSettlement(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && propertyName(node) === 'boundaryRemainder') boundaries.push(node);
    ts.forEachChild(node, visitSettlement);
  }
  visitSettlement(settlement);
  const [boundary] = boundaries;
  if (boundary === undefined || boundaries.length !== 1) {
    violations.push(
      `${SHUTDOWN_SETTLEMENT_PATH} must contain exactly one boundaryRemainder ownership site; found ${boundaries.length}`,
    );
  } else {
    inspectProcessExitOwner('boundaryRemainder', boundary.initializer, boundary);
  }

  return violations;
}

function ownershipShapeViolations(): string[] {
  const violations: string[] = [];

  for (const file of sourceFiles(OWNERSHIP_SCAN_ROOT)) {
    function visit(node: ts.Node): void {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node) === 'owner' &&
        ownerLiteral(node) === 'successor-recovery'
      ) {
        if (!ts.isObjectLiteralExpression(node.parent)) {
          violations.push(`${location(node)} successor-recovery owner must belong to an object literal`);
        } else {
          const evidence = propertyAssignment(node.parent, 'evidence');
          const via = propertyAssignment(node.parent, 'via');
          if (via !== undefined) {
            violations.push(`${location(via)} successor-recovery remainder must not use free-form via evidence`);
          }
          const evidenceValue = evidence === undefined ? undefined : unwrapExpression(evidence.initializer);
          if (evidence === undefined || evidenceValue === undefined || !ts.isObjectLiteralExpression(evidenceValue)) {
            violations.push(`${location(node)} successor-recovery remainder must carry typed evidence`);
          } else {
            const kind = propertyAssignment(evidenceValue, 'kind');
            if (kind === undefined || !ts.isStringLiteral(unwrapExpression(kind.initializer))) {
              violations.push(`${location(evidence)} successor-recovery evidence must carry a literal kind`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  const settlement = sourceFile(SHUTDOWN_SETTLEMENT_PATH);
  const remainder = settlement.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'UndischargedRemainder',
  );
  if (remainder === undefined) {
    violations.push(`${SHUTDOWN_SETTLEMENT_PATH} must declare UndischargedRemainder`);
  } else {
    const declaration = remainder.type.getText(settlement);
    const armCount = ts.isUnionTypeNode(remainder.type) ? remainder.type.types.length : 1;
    if (armCount !== 2) {
      violations.push(`UndischargedRemainder must contain exactly two owner arms; found ${armCount}`);
    }
    if (!/evidence\s*:\s*SuccessorRecoveryEvidence/u.test(declaration)) {
      violations.push('UndischargedRemainder successor-recovery owner must require SuccessorRecoveryEvidence');
    }
    if (/\bvia\b/u.test(declaration)) {
      violations.push('UndischargedRemainder must not admit free-form via evidence');
    }
  }

  return violations;
}

describe('shutdown remainder ownership inventory', () => {
  it('keeps every migrated obligation and the authority-release boundary assigned to process exit', () => {
    expect(processExitInventoryViolations()).toEqual([]);
  });

  it('rejects ownerless production state and untyped successor-recovery evidence across src', () => {
    expect(ownershipShapeViolations()).toEqual([]);
  });
});
