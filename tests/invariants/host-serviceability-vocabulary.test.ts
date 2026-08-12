import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_PATH = resolve(REPO_ROOT, 'src/providers/host-serviceability.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');
const sourceFile = ts.createSourceFile(SOURCE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const EXPECTED_VOCABULARIES = {
  HostProcessState: ['closed', 'open'],
  HostServiceability: ['serviceable', 'unknown', 'unserviceable'],
  HostAdmission: ['blocked', 'candidate'],
} as const;

function findTypeAlias(name: string): ts.TypeAliasDeclaration | undefined {
  return sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
}

function literalUnionMembers(declaration: ts.TypeAliasDeclaration): string[] | undefined {
  if (!ts.isUnionTypeNode(declaration.type)) return undefined;

  const members = declaration.type.types.map((member) =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : undefined,
  );
  return members.every((member): member is string => member !== undefined) ? members.sort() : undefined;
}

describe('provider host state vocabularies', () => {
  it('declares three independent literal unions without conflating carrier liveness and serviceability', () => {
    const violations = Object.entries(EXPECTED_VOCABULARIES).flatMap(([name, expected]) => {
      const declaration = findTypeAlias(name);
      if (declaration === undefined) return [`${name} must be declared in src/providers/host-serviceability.ts`];

      const actual = literalUnionMembers(declaration);
      if (actual !== undefined && actual.join('|') === [...expected].sort().join('|')) return [];

      const declaredType = declaration.type.getText(sourceFile);
      if (name === 'HostServiceability' && declaredType.includes('CarrierLiveness')) {
        return [
          'HostServiceability must not alias CarrierLiveness; carrier presence and host serviceability are distinct vocabularies',
        ];
      }
      return [`${name} must directly declare ${[...expected].sort().join(' | ')}; found ${declaredType}`];
    });

    expect(violations).toEqual([]);
  });
});
