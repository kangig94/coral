import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const HANDOFF_MODULE = 'src/coordinator/handoff.ts';

type ProductionSource = Readonly<{
  file: string;
  sourceFile: ts.SourceFile;
}>;

function productionSources(): ProductionSource[] {
  return listProductionSourceFiles(resolve(REPO_ROOT, 'src')).map((filePath) => ({
    file: relative(REPO_ROOT, filePath).replaceAll('\\', '/'),
    sourceFile: ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true),
  }));
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}

function constructsBoundCoordinator(node: ts.ObjectLiteralExpression): boolean {
  const properties = new Set(
    node.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name.text];
      }
      if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
        const name = propertyNameText(property.name);
        return name === null ? [] : [name];
      }
      return [];
    }),
  );
  return properties.has('acquiredViaHandoff') && properties.has('runStartupRecovery');
}

function scanBoundCoordinatorOwners(sources: readonly ProductionSource[]): string[] {
  const owners: string[] = [];
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && constructsBoundCoordinator(node)) {
        owners.push(source.file);
      }
      ts.forEachChild(node, visit);
    };
    visit(source.sourceFile);
  }

  if (owners.length !== 1) {
    return [`expected one bound coordinator construction site, found ${owners.length}`];
  }
  return owners[0] === HANDOFF_MODULE ? [] : [`${owners[0]}: bound coordinator constructed outside handoff owner`];
}

describe('coordinator-bind-authority', () => {
  it('should keep the bound coordinator capability at one production construction site', () => {
    expect(scanBoundCoordinatorOwners(productionSources())).toEqual([]);
  });

  it('should reject a second bound coordinator construction site', () => {
    const rogue = ts.createSourceFile(
      'src/coordinator/rogue-bound-coordinator.ts',
      `const forged = { acquiredViaHandoff: false, runStartupRecovery: async () => [] }; void forged;`,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(
      scanBoundCoordinatorOwners([
        ...productionSources(),
        { file: 'src/coordinator/rogue-bound-coordinator.ts', sourceFile: rogue },
      ]),
    ).toEqual(['expected one bound coordinator construction site, found 2']);
  });
});
