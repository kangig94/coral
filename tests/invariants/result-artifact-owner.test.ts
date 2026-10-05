import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { beforeAll, expect, it } from 'vitest';
import {
  listProductionSourceFiles,
  parseSourceImportEdges,
  createProductionFileIndex,
} from '#tests/helpers/ts-import-scanner.js';

const root = resolve('.');
const files = listProductionSourceFiles(resolve(root, 'src'));
const owner = 'src/jobs/terminal/export.ts';
const parsed = new Map<string, ts.SourceFile>();
beforeAll(() => {
  for (const path of files)
    parsed.set(path, ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true));
});

it('gives only the jobs terminal export owner access to result.md publication', () => {
  const violations: string[] = [];
  for (const path of files) {
    if (relative(root, path) === owner) continue;
    const source = parsed.get(path)!;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isIdentifier(node) && node.text === 'writeResultArtifact') ||
        (ts.isStringLiteralLike(node) && node.text === 'result.md')
      )
        violations.push(relative(root, path));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

it('keeps jobs independent of the workflow domain through the injected report port', () => {
  const index = createProductionFileIndex(root, files);
  const edges = files.flatMap((file) => parseSourceImportEdges(root, file, index, parsed.get(file)));
  expect(
    edges.filter((edge) => edge.source.startsWith('src/jobs/') && edge.target.startsWith('src/workflow/')),
  ).toEqual([]);
});

it.each<[string, string[]]>([
  ['src/jobs/wait/contract.ts', ['./cursor.js', './session.js']],
  ['src/cli/format/wait.ts', ['./result-availability.js']],
  ['src/coordinator/lifecycle.ts', ['../jobs/retention-clock.js']],
])('keeps owner-specific APIs out of foreign re-exports in %s', (path, owners) => {
  const source = parsed.get(resolve(root, path))!;
  const reexports = source.statements.flatMap((node) =>
    ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? [node.moduleSpecifier.text]
      : [],
  );
  expect(reexports.filter((owner) => owners.includes(owner))).toEqual([]);
});
