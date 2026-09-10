import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
// The launch-permit migration owns these domains. Broadening this gate requires
// a deliberate audit of the rest of src.
const SCANNED_ROOTS = ['src/coordinator', 'src/jobs', 'src/recovery'] as const;
const FILES = SCANNED_ROOTS.flatMap((root) => listProductionSourceFiles(resolve(REPO_ROOT, root)));
const COMPILER_OPTIONS = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
} satisfies ts.CompilerOptions;
const PROGRAM = ts.createProgram(FILES, COMPILER_OPTIONS);
const FIXTURE_ROOT = resolve(REPO_ROOT, 'tests/invariants/fixtures/must-use-union-return');

type Offender = Readonly<{ file: string; line: number; text: string }>;

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function discardedCall(expression: ts.Expression): ts.CallExpression | ts.AwaitExpression | null {
  const current = unwrapExpression(expression);
  if (ts.isVoidExpression(current)) return null;
  if (ts.isCallExpression(current)) return current;
  if (ts.isAwaitExpression(current) && ts.isCallExpression(unwrapExpression(current.expression))) return current;
  return null;
}

function hasStringLiteralKind(type: ts.Type, location: ts.Node, checker: ts.TypeChecker): boolean {
  const property = type.getProperty('kind');
  if (property === undefined) return false;
  const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
  return checker.getTypeOfSymbolAtLocation(property, declaration).isStringLiteral();
}

function isMustUseUnion(type: ts.Type, location: ts.Node, checker: ts.TypeChecker): boolean {
  if (!type.isUnion() || type.types.length < 2) return false;
  return (
    type.types.every((member) => member.isStringLiteral()) ||
    type.types.every((member) => hasStringLiteralKind(member, location, checker))
  );
}

function collectOffenders(program: ts.Program, sourceFiles: readonly ts.SourceFile[]): Offender[] {
  const checker = program.getTypeChecker();
  const offenders: Offender[] = [];
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        const result = discardedCall(node.expression);
        if (result !== null && isMustUseUnion(checker.getTypeAtLocation(result), result, checker)) {
          offenders.push({
            file: sourceFile.fileName.startsWith(resolve(REPO_ROOT, 'src'))
              ? toCanonicalSrcPath(REPO_ROOT, sourceFile.fileName)
              : relative(REPO_ROOT, sourceFile.fileName).replace(/\\/gu, '/'),
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            text: node.getText(sourceFile),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return offenders;
}

function fixtureProgram(name: string): { program: ts.Program; sourceFile: ts.SourceFile } {
  const fixturePath = resolve(FIXTURE_ROOT, `${name}.ts`);
  const source = readFileSync(`${fixturePath}.txt`, 'utf8');
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const defaultFileExists = host.fileExists;
  const defaultGetSourceFile = host.getSourceFile;
  const defaultReadFile = host.readFile;
  host.fileExists = (fileName) => fileName === fixturePath || defaultFileExists(fileName);
  host.readFile = (fileName) => (fileName === fixturePath ? source : defaultReadFile(fileName));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === fixturePath
      ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
      : defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [fixturePath], options: COMPILER_OPTIONS, host });
  const sourceFile = program.getSourceFile(fixturePath);
  if (sourceFile === undefined) throw new Error(`Must-use fixture '${name}' was not compiled.`);
  return { program, sourceFile };
}

describe('discriminated-union returns are must-use', () => {
  it('requires every discarded union result to carry an explicit void marker', () => {
    const sources = FILES.flatMap((filePath) => {
      const sourceFile = PROGRAM.getSourceFile(filePath);
      return sourceFile === undefined ? [] : [sourceFile];
    });
    expect(collectOffenders(PROGRAM, sources)).toEqual([]);
  });

  it('detects discarded object and string unions', () => {
    const fixture = fixtureProgram('negative');
    expect(collectOffenders(fixture.program, [fixture.sourceFile])).toHaveLength(2);
  });

  it('accepts explicit discards and consumed union results', () => {
    const fixture = fixtureProgram('positive');
    expect(collectOffenders(fixture.program, [fixture.sourceFile])).toEqual([]);
  });
});
