import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { codeTextOnly } from '../helpers/ts-code-text.js';

const REPO_ROOT = join(__dirname, '..', '..');
const HANDOFF_CLASSIFIER = 'src/coordinator/handoff.ts';

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return current.name.text;
    }
  }
  throw new Error('HandoffEscalationError construction must be inside a named function');
}

function escalationCode(node: ts.NewExpression): string {
  const init = node.arguments?.[0];
  if (init === undefined || !ts.isObjectLiteralExpression(init)) {
    throw new Error('HandoffEscalationError construction must use an object literal');
  }
  const code = init.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      property.name.getText() === 'code',
  );
  if (code !== undefined && ts.isPropertyAssignment(code) && ts.isStringLiteral(code.initializer)) {
    return code.initializer.text;
  }
  if (code !== undefined && ts.isShorthandPropertyAssignment(code)) {
    for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
      if (ts.isCaseClause(current) && ts.isStringLiteral(current.expression)) {
        return current.expression.text;
      }
    }
  }
  throw new Error('HandoffEscalationError code must be a literal or a narrowed switch case');
}

function handoffEscalationConstructionSites(source: string): string[] {
  const sourceFile = ts.createSourceFile(HANDOFF_CLASSIFIER, source, ts.ScriptTarget.Latest, true);
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'HandoffEscalationError'
    ) {
      sites.push(`${enclosingFunctionName(node)}:${escalationCode(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

describe('handoff refusal classification ownership', () => {
  it('constructs HandoffEscalationError only in the canonical classifier', () => {
    const constructionSites = listTypeScriptFiles(join(REPO_ROOT, 'src'))
      .filter((path) => /\bnew\s+HandoffEscalationError\s*\(/u.test(codeTextOnly(readFileSync(path, 'utf-8'))))
      .map((path) => relative(REPO_ROOT, path).replace(/\\/gu, '/'))
      .sort();

    expect(constructionSites).toEqual([HANDOFF_CLASSIFIER]);
  });

  it('pins every construction to the approved refusal-observation inventory', () => {
    const source = readFileSync(join(REPO_ROOT, HANDOFF_CLASSIFIER), 'utf-8');

    // Both directions hold: no construction outside this inventory, and no entry in it without a
    // construction. A repeated pair is a second classification site for one code, so the comparison keeps
    // multiplicity. What it must not depend on is position — where a `throw` sits inside the function that
    // owns it is not a change of ownership, and an inventory that fails for it gets re-synced rather than read.
    const approved = [
      'bindWithHandoff:handoff_socket_holder_unverified',
      'bindWithHandoff:handoff_socket_holder_unverified',
      'bindWithHandoff:handoff_socket_holder_unverified',
    ];

    expect(handoffEscalationConstructionSites(source).sort()).toEqual(approved.sort());
  });
});
