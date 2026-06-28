import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const PROTOCOL_PATH = resolve(SRC_ROOT, 'kb-daemon/protocol.ts');

const DAEMON_REQUEST_TYPES = [
  'KbDaemonKbReadRequest',
  'KbDaemonKbMutationRequest',
  'KbDaemonExpansionRequest',
] as const;

type Location = {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
};

function parseSourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function typeAlias(sourceFile: ts.SourceFile, name: string): ts.TypeAliasDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      return statement;
    }
  }
  return null;
}

function typeLiteralMembers(alias: ts.TypeAliasDeclaration): ts.NodeArray<ts.TypeElement> | null {
  return ts.isTypeLiteralNode(alias.type) ? alias.type.members : null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return null;
}

function propertySignature(members: ts.NodeArray<ts.TypeElement>, name: string): ts.PropertySignature | null {
  for (const member of members) {
    if (ts.isPropertySignature(member) && propertyNameText(member.name) === name) {
      return member;
    }
  }
  return null;
}

function location(sourceFile: ts.SourceFile, node: ts.Node, canonicalPath: string): Location {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { filePath: canonicalPath, line: position.line + 1, column: position.character + 1 };
}

function daemonProtocolCtxViolations(): string[] {
  const sourceFile = parseSourceFile(PROTOCOL_PATH);
  const violations: string[] = [];
  const contextAlias = typeAlias(sourceFile, 'KbDaemonRequestContextWire');
  const contextMembers = contextAlias === null ? null : typeLiteralMembers(contextAlias);
  const principal = contextMembers === null ? null : propertySignature(contextMembers, 'principal');

  if (contextAlias === null || contextMembers === null) {
    violations.push('src/kb-daemon/protocol.ts: missing KbDaemonRequestContextWire type literal');
  } else if (principal === null) {
    violations.push('src/kb-daemon/protocol.ts: KbDaemonRequestContextWire must carry principal');
  } else if (principal.questionToken !== undefined || principal.type?.getText(sourceFile) !== 'PrincipalWire') {
    violations.push('src/kb-daemon/protocol.ts: KbDaemonRequestContextWire.principal must be required PrincipalWire');
  }

  for (const requestType of DAEMON_REQUEST_TYPES) {
    const alias = typeAlias(sourceFile, requestType);
    const members = alias === null ? null : typeLiteralMembers(alias);
    const ctx = members === null ? null : propertySignature(members, 'ctx');
    if (alias === null || members === null) {
      violations.push(`src/kb-daemon/protocol.ts: missing ${requestType} type literal`);
      continue;
    }
    if (ctx === null) {
      violations.push(`src/kb-daemon/protocol.ts: ${requestType} must carry ctx`);
      continue;
    }
    if (ctx.questionToken !== undefined || ctx.type?.getText(sourceFile) !== 'KbDaemonRequestContextWire') {
      violations.push(`src/kb-daemon/protocol.ts: ${requestType}.ctx must be required KbDaemonRequestContextWire`);
    }
  }

  return violations;
}

function collectNullishAdminFallbacks(): string[] {
  const files = listProductionSourceFiles(SRC_ROOT).filter((filePath) =>
    toCanonicalSrcPath(REPO_ROOT, filePath).startsWith('src/kb-daemon/'),
  );
  const violations: Location[] = [];

  for (const filePath of files) {
    const canonicalPath = toCanonicalSrcPath(REPO_ROOT, filePath);
    const sourceFile = parseSourceFile(filePath);

    function visit(node: ts.Node): void {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        ts.isStringLiteralLike(node.right) &&
        node.right.text === 'admin'
      ) {
        violations.push(location(sourceFile, node.right, canonicalPath));
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations
    .sort((left, right) => {
      if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
      if (left.line !== right.line) return left.line - right.line;
      return left.column - right.column;
    })
    .map((entry) => `${entry.filePath}:${entry.line}:${entry.column}: forbidden ?? 'admin' daemon fallback`);
}

describe('KB daemon principal wire seam', () => {
  it('requires PrincipalWire ctx on read, mutation, and expansion protocol requests', () => {
    expect(daemonProtocolCtxViolations()).toEqual([]);
  });

  it('does not re-default missing daemon authority to admin', () => {
    expect(collectNullishAdminFallbacks()).toEqual([]);
  });
});
