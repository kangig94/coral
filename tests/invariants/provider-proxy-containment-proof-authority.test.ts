import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const PROVER_FILE = 'src/coordinator/services/provider-proxy-set/containment-proof.ts';
const PROVER_FUNCTION = 'createProviderProxySetContainmentProver';
const PROOF_TYPE = 'ProviderProxySetContainmentProof';

function canonicalPath(filePath: string): string {
  return relative(REPO_ROOT, filePath).split(sep).join('/');
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? null;
  }
  return null;
}

function isObjectConstruction(expression: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(expression) || ts.isNewExpression(expression)) return true;
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.getText() === 'Object' &&
    (expression.expression.name.text === 'freeze' || expression.expression.name.text === 'create')
  );
}

function proofMints(filePath: string): readonly string[] {
  const sourceText = readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const mints: string[] = [];
  const location = (node: ts.Node, kind: string): string => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return `${canonicalPath(filePath)}:${line}:${enclosingFunctionName(node) ?? '<module>'}:${kind}`;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && node.type.getText(source) === PROOF_TYPE && isObjectConstruction(node.expression)) {
      mints.push(location(node, 'brand'));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'containmentProofRecords' &&
      node.expression.name.text === 'set'
    ) {
      mints.push(location(node, 'record'));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return mints;
}

describe('provider proxy containment proof authority', () => {
  it('allows only the real prover to construct the proof brand', () => {
    const mints = listProductionSourceFiles(SRC_ROOT).flatMap(proofMints);
    const expectedLocation = new RegExp(`^${PROVER_FILE}:\\d+:${PROVER_FUNCTION}:`, 'u');

    expect(mints).toEqual([
      expect.stringMatching(new RegExp(`${expectedLocation.source}brand$`, 'u')),
      expect.stringMatching(new RegExp(`${expectedLocation.source}record$`, 'u')),
    ]);
  });
});
