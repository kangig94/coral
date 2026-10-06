import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

it('forbids production construction of a builds directory and the retired copy owner', () => {
  const violations: string[] = [];
  for (const path of listProductionSourceFiles(resolve('src'))) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /(?:^|[/\\])builds(?:$|[/\\])/.test(node.text)
      ) {
        violations.push(`${relative(process.cwd(), path)}: builds path construction`);
      }
      if (
        ts.isIdentifier(node) &&
        /^(pinRunningBuildRoot|retainedBuildRoot|validatedRetainedBuildRoot)$/.test(node.text)
      ) {
        violations.push(`${relative(process.cwd(), path)}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
  expect(existsSync('src/infra/retained-build-root.ts')).toBe(false);
});
