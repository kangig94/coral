// `issueWithSuccessorAfterLifecycleRefusal` may re-issue a lifecycle-refused request to a successor, so every
// lifecycle refusal must be produced before any effect.
//
// See 'refuses before any effect when the saga stop can no longer be recorded' in
// tests/unit/coordinator/composition/job-control.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CANONICAL_FILE = 'src/transport/lifecycle-refusal.ts';
const DISPATCH_FILE = 'src/transport/dispatch.ts';
const IPC_SERVER_FILE = 'src/transport/ipc/server.ts';
const REFUSAL_CODE = 'backend_shutting_down';
const RECOGNIZING_POSITION = new RegExp(String.raw`(?:[=!]==\s*|case\s+)(['"\`])${REFUSAL_CODE}\1`, 'g');

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.ts')) {
        found.push(relative(ROOT, path));
      }
    }
  };
  walk(join(ROOT, 'src'));
  return found.sort();
}

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe('lifecycle refusal body single-home invariant', () => {
  it(`constructs the ${REFUSAL_CODE} body only in ${CANONICAL_FILE}`, () => {
    const canonical = readFileSync(join(ROOT, CANONICAL_FILE), 'utf-8');
    expect(canonical).toMatch(new RegExp(String.raw`code:\s*'${REFUSAL_CODE}'`));

    const constructors = sourceFiles()
      .filter((path) => path !== CANONICAL_FILE)
      .filter((path) => {
        const text = readFileSync(join(ROOT, path), 'utf-8');
        const mentions = countOccurrences(text, new RegExp(REFUSAL_CODE, 'g'));
        return mentions > countOccurrences(text, RECOGNIZING_POSITION);
      });

    expect(constructors).toEqual([]);
  });

  it('keeps two pre-dispatch refusal writes and one post-dispatch lifecycle-refused write', () => {
    const text = readFileSync(join(ROOT, IPC_SERVER_FILE), 'utf-8');
    const dispatchLookup = text.indexOf('dispatchMap.get(request.method)');
    const lifecycleRefusedBranch = text.indexOf("if (invocation.kind === 'lifecycle-refused')");
    const unaryBranch = text.indexOf("if (invocation.kind === 'unary')", lifecycleRefusedBranch);
    // The write, not the import: matching the bare symbol would count the import line as a third gate.
    const refusalWrites = [...text.matchAll(/result: lifecycleRefusalResult/g)].map((match) => match.index);

    expect(dispatchLookup).toBeGreaterThan(-1);
    expect(lifecycleRefusedBranch).toBeGreaterThan(dispatchLookup);
    expect(unaryBranch).toBeGreaterThan(lifecycleRefusedBranch);
    expect(refusalWrites).toHaveLength(3);
    expect(refusalWrites.filter((index) => index < dispatchLookup)).toHaveLength(2);
    expect(refusalWrites.filter((index) => index > lifecycleRefusedBranch && index < unaryBranch)).toHaveLength(1);
  });

  it('constructs lifecycle-refused only in the jobs.abort successor-owned arm', () => {
    const constructors = sourceFiles().flatMap((path) => {
      const text = readFileSync(join(ROOT, path), 'utf-8');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const found: Array<{ path: string; index: number }> = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isObjectLiteralExpression(node) &&
          node.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === 'kind' &&
              ts.isStringLiteral(property.initializer) &&
              property.initializer.text === 'lifecycle-refused',
          )
        ) {
          found.push({ path, index: node.getStart(source) });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    });
    expect(constructors).toHaveLength(1);
    expect(constructors[0]?.path).toBe(DISPATCH_FILE);

    const text = readFileSync(join(ROOT, DISPATCH_FILE), 'utf-8');
    const functionStart = text.indexOf('async function executeJobsAbortCatalogRequest');
    const functionEnd = text.indexOf('\nasync function ', functionStart + 1);
    const successorOwnedArm = text.indexOf("case 'successor-owned':", functionStart);
    const constructor = constructors[0]?.index ?? -1;

    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(successorOwnedArm).toBeGreaterThan(functionStart);
    expect(successorOwnedArm).toBeLessThan(functionEnd);
    expect(constructor).toBeGreaterThan(successorOwnedArm);
    expect(constructor).toBeLessThan(functionEnd);
  });
});
