// Regenerating operator text from the documented catalog assumes the catalog names every code this build can
// throw. It does not, and completing it is not a property anything can check: around forty codes live at the
// sites that throw them, each with prose a per-code catalog template cannot reproduce. So the reader answers
// an uncatalogued code from the record's own prose, and what stays checkable is the pair of conditions that
// makes doing so safe — authorship is decided per record, and no surface handles a subset of the dispositions.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const ERRORS_MODULE = 'src/runtime/errors.ts';
const READER = 'readOperatorFacingCoralSetupError';
const AUTHORSHIP_RESOLVER = 'resolveSetupErrorAuthorship';
const AUTHORSHIP_PROOF = 'setupErrorAuthorshipProof';
const DISPOSITION_TYPE = 'OperatorFacingCoralSetupError';

type SourceFileText = Readonly<{ file: string; source: string }>;

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

function readSourceTree(): SourceFileText[] {
  return listTypeScriptFiles(join(REPO_ROOT, 'src')).map((path) => ({
    file: relative(REPO_ROOT, path).replace(/\\/gu, '/'),
    source: readFileSync(path, 'utf-8'),
  }));
}

function parse({ file, source }: SourceFileText): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => eachNode(child, visit));
}

function callsResolver(node: ts.Node): boolean {
  let found = false;
  eachNode(node, (inner) => {
    if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return;
    if (inner.expression.text === AUTHORSHIP_RESOLVER) found = true;
  });
  return found;
}

/** The dispositions the reader can return, read from the union itself so a new one cannot be added quietly. */
function dispositionKinds(sourceFile: ts.SourceFile): string[] {
  const kinds: string[] = [];
  eachNode(sourceFile, (node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== DISPOSITION_TYPE) return;
    eachNode(node.type, (member) => {
      if (!ts.isPropertySignature(member) || member.name.getText() !== 'kind') return;
      const literal = member.type;
      if (literal !== undefined && ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal)) {
        kinds.push(literal.literal.text);
      }
    });
  });
  return kinds;
}

/** Named helpers that end at the resolver, so routing through one still counts as deciding at the call. */
function authorshipDecidingFunctions(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  eachNode(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) || node.name === undefined || node.body === undefined) return;
    const name = node.name.text;
    if (callsResolver(node.body)) names.add(name);
  });
  return names;
}

function undecidedReaderCalls(sourceFile: ts.SourceFile): string[] {
  const deciding = authorshipDecidingFunctions(sourceFile);
  const undecided: string[] = [];
  eachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    if (node.expression.text !== READER) return;
    const argument = node.arguments[1];
    if (argument === undefined) {
      undecided.push(`${sourceFile.fileName}: <no authorship argument>`);
      return;
    }
    const decidedHere =
      ts.isCallExpression(argument) &&
      ts.isIdentifier(argument.expression) &&
      (argument.expression.text === AUTHORSHIP_RESOLVER || deciding.has(argument.expression.text));
    if (!decidedHere) undecided.push(`${sourceFile.fileName}: ${argument.getText()}`);
  });
  return undecided;
}

describe('operator-facing setup-error disposition', () => {
  const sourceTree = readSourceTree();
  const errorsModule = sourceTree.find(({ file }) => file === ERRORS_MODULE);
  if (errorsModule === undefined) throw new Error(`${ERRORS_MODULE} is the disposition's home and must exist`);
  const kinds = dispositionKinds(parse(errorsModule));

  it('derives the disposition set from the union that owns it', () => {
    // Every assertion below filters against this set, so an empty derivation would make each of them vacuous.
    expect(kinds.length).toBeGreaterThan(1);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  // A record's prose may be shown only to the build that wrote it, so authorship is evidence about that exact
  // record. An argument that is not a call decided it somewhere else — for another record, or for none.
  it('decides authorship at every reader call', () => {
    const readers = sourceTree.filter(({ source }) => source.includes(`${READER}(`));

    expect(readers.length).toBeGreaterThan(0);
    expect(readers.flatMap((entry) => undecidedReaderCalls(parse(entry)))).toEqual([]);
  });

  // Handling a subset is the defect this file exists for: the arm a surface forgets does not disappear, it
  // falls into whatever `else` or `default` that surface already had, and an operator reads the wrong sentence.
  it('leaves no consumer handling a subset of the dispositions', () => {
    const partial = sourceTree
      .filter(({ file, source }) => file !== ERRORS_MODULE && source.includes(DISPOSITION_TYPE))
      .map(({ file, source }) => ({ file, named: kinds.filter((kind) => source.includes(`'${kind}'`)) }))
      .filter(({ named }) => named.length > 0 && named.length < kinds.length);

    expect(partial).toEqual([]);
  });

  // The proof is what a caller cannot forge. If a second module could stamp it, `this-build` would become a
  // claim any surface can make about a record it never compared.
  it('mints an authorship proof in exactly one module', () => {
    const minting = sourceTree
      .filter(({ source }) => source.includes(AUTHORSHIP_PROOF))
      .map(({ file }) => file)
      .sort();

    expect(minting).toEqual([ERRORS_MODULE]);
  });
});
