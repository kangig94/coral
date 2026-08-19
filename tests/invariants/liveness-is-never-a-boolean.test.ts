// `ProcessLiveness` may not be used where a boolean is meant.
//
// It is a string union, so all three of its values are truthy — `if (!observeLiveness(pid))` is never true and
// `if (observeLiveness(pid))` is always true. Neither is a type error, and both read exactly like the boolean
// API they replaced. That is not hypothetical: the conversion left `if (!...observeLiveness(pid))` guarding the
// simulator's kill, so a kill of an inactive pid reported success. The type moved the caller audit to the
// compiler and this is the one hole the compiler cannot see.
//
// The rule is therefore syntactic and narrow: a call to a liveness probe must be compared, not coerced.
//
// It stays narrow deliberately. A companion rule banning `!== 'alive'` was written and deleted, because the
// syntax does not carry the defect. `!== 'alive'` is true for `'unknown'` too, so *concluding absence* from it
// promotes "could not observe" into "is gone" — but *refusing* on it is the conservative direction and is what
// `.claude/rules/validation.md` requires of every signal ("only `alive` may authorize SIGKILL. A target that
// could not be observed is refused, not escalated"). Across the three roots this file scans there are two
// occurrences and both are the refusing kind: `tools/simulation/adversarial.ts` guarding a kill — the very fix
// this file's paragraph above describes — and `tests/e2e/cli/lifecycle/mutate-via-ipc.test.ts` guarding a
// shutdown of a bare recorded pid. A ban would have flagged both and nothing else: no true positive, and two
// false positives, one of them a documented fix. (The count was written as one before it was measured on all
// three roots rather than two, which is the kind of claim this file exists to distrust.)
//
// What separates the two is the consequent, not the comparison, and a scanner cannot read a consequent without
// becoming a heuristic that the next writer routes around. Absence-from-`unknown` is held instead where it is
// decidable: by the three-variant return types (`CoordinatorProbe`, `DiscoveryRead`) and by the tests that
// assert what each variant does, not by a grep over how the variant was spelled.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
// `tests` is scanned too: a double that answers a boolean behind a cast is how the conversion's first three
// bugs stayed green, and a test that coerces a liveness value is asserting nothing.
const SCANNED_ROOTS = ['src', 'tools', 'tests'] as const;
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

/** Whether this expression is consumed as a truth value rather than compared against a literal. */
function isCoercedToBoolean(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isIfStatement(parent) && parent.expression === node) return true;
  if (ts.isWhileStatement(parent) && parent.expression === node) return true;
  if (ts.isDoStatement(parent) && parent.expression === node) return true;
  if (ts.isForStatement(parent) && parent.condition === node) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === node) return true;
  if (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    return (
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    );
  }
  return false;
}

/**
 * Names bound directly to a liveness answer in this file — `const state = observeLiveness(pid)`.
 *
 * The first version of this rule looked only at the call's own parent, so storing the answer in a variable and
 * coercing *that* passed. It is one extra hop and it is the hop a reader naturally reaches for, so it is the
 * hop the rule has to follow. It does not chase further than one binding: this is a syntactic scan, and
 * pretending otherwise is how a green result gets over-read.
 */
function livenessBoundNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isLivenessCall(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The scan itself, over one file's text, so it can be run against a fixture as well as against the tree. */
function coercionsIn(fileName: string, text: string): Offender[] {
  const offenders: Offender[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const bound = livenessBoundNames(source);
  const visit = (node: ts.Node): void => {
    const isAnswer = isLivenessCall(node) || (ts.isIdentifier(node) && bound.has(node.text));
    if (isAnswer && isCoercedToBoolean(node)) {
      offenders.push({
        file: fileName,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: node.getText(source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe('a liveness answer is compared, never coerced', () => {
  it('no call site uses ProcessLiveness as a truth value', () => {
    const offenders: Offender[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const filePath of listSourceFiles(root)) {
        const canonical = relative(REPO_ROOT, filePath).replace(/\\/gu, '/');
        offenders.push(...coercionsIn(canonical, readFileSync(filePath, 'utf-8')));
      }
    }

    // To resolve: compare against the answer you actually mean — `=== 'alive'` to act on observed life,
    // `=== 'absent'` to act on observed absence. Neither is the same as "not the other one".
    expect(offenders).toEqual([]);
  });

  // The scan itself, against shapes the tree does not contain — which is the point: a rule with no negative
  // fixture is a rule nobody has seen fail. The alias case is the one that mattered; the first version of this
  // rule looked only at the call's own parent and let it through.
  it.each([
    ['a direct call negated', 'if (!observeLiveness(pid)) throw new Error("x");'],
    ['a direct call as a condition', 'if (observeProcessLiveness(pid)) kill(pid);'],
    ['an alias negated', 'const state = observeLiveness(pid);\nif (!state) throw new Error("x");'],
    ['an alias as a condition', 'const state = observeProcessLiveness(pid);\nif (state) kill(pid);'],
    ['an alias in a ternary', 'const state = observeLiveness(pid);\nconst x = state ? 1 : 2;'],
    ['an alias in a logical chain', 'const state = observeLiveness(pid);\nconst x = state && other;'],
    ['an alias interpolated', 'const state = observeLiveness(pid);\nconst x = `${state}`;'],
  ])('catches %s', (_label, snippet) => {
    expect(coercionsIn('fixture.ts', snippet)).not.toHaveLength(0);
  });

  it.each([
    ['an explicit alive comparison', "if (observeLiveness(pid) === 'alive') kill(pid);"],
    ['an explicit absent comparison', "if (observeProcessLiveness(pid) === 'absent') return;"],
    ['an alias compared explicitly', "const state = observeLiveness(pid);\nif (state === 'alive') kill(pid);"],
    ['an unrelated boolean', 'if (!somethingElse(pid)) throw new Error("x");'],
  ])('allows %s', (_label, snippet) => {
    expect(coercionsIn('fixture.ts', snippet)).toEqual([]);
  });
});
