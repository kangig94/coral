// `ProcessLiveness` may not be used where a boolean is meant.
//
// It is a string union, so all three of its values are truthy — `if (!observeLiveness(pid))` is never true and
// `if (observeLiveness(pid))` is always true. Neither is a type error, and both read exactly like the boolean
// API they replaced. That is not hypothetical: the conversion left `if (!...observeLiveness(pid))` guarding the
// simulator's kill, so a kill of an inactive pid reported success. The type moved the caller audit to the
// compiler and this is the one hole the compiler cannot see.
//
// The rule is therefore syntactic and narrow: a call to a liveness probe must be compared, not coerced.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const SCANNED_ROOTS = ['src', 'tools'] as const;
const LIVENESS_PROBE = /^(observeProcessLiveness|observeLiveness)$/;

type Offender = Readonly<{ file: string; line: number; text: string }>;

function listSourceFiles(root: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [join(REPO_ROOT, root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(absolute);
    }
  }
  return collected;
}

function isLivenessCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  return ts.isIdentifier(callee) && LIVENESS_PROBE.test(callee.text);
}

/** Whether this expression's value is consumed as a truth value rather than compared against a literal. */
function isCoercedToBoolean(call: ts.CallExpression): boolean {
  const parent = call.parent;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isIfStatement(parent) && parent.expression === call) return true;
  if (ts.isWhileStatement(parent) && parent.expression === call) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === call) return true;
  if (ts.isBinaryExpression(parent)) {
    const logical =
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken;
    if (logical) return true;
  }
  return false;
}

describe('a liveness answer is compared, never coerced', () => {
  it('no call site uses ProcessLiveness as a truth value', () => {
    const offenders: Offender[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const filePath of listSourceFiles(root)) {
        const canonical = relative(REPO_ROOT, filePath).replace(/\\/gu, '/');
        const source = ts.createSourceFile(canonical, readFileSync(filePath, 'utf-8'), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
          if (isLivenessCall(node) && isCoercedToBoolean(node)) {
            offenders.push({
              file: canonical,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              text: node.getText(source),
            });
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }

    // To resolve: compare against the answer you actually mean — `=== 'alive'` to act on observed life,
    // `=== 'absent'` to act on observed absence. Neither is the same as "not the other one".
    expect(offenders).toEqual([]);
  });
});
