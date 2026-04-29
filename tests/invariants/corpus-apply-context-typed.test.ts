import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const ENGINE_ROOT = join(SRC_ROOT, 'engines');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return listSourceFiles(path);
      }
      return path.endsWith('.ts') ? [path] : [];
    })
    .sort();
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

describe('typed corpus apply boundary', () => {
  it('does not expose a raw BetterSqlite3 db on CorpusConsumerApplyContext', () => {
    const path = join(SRC_ROOT, 'store/consumer-contract.ts');
    const source = sourceFile(path);
    const dbMembers: string[] = [];
    const betterSqliteMembers: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'CorpusConsumerApplyContext') {
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) || member.name === undefined) {
            continue;
          }
          const name = propertyNameText(member.name);
          if (name === 'db') {
            dbMembers.push('db');
          }
          const renderedType = member.type?.getText(source) ?? '';
          if (/BetterSqlite3\s*\.\s*Database/.test(renderedType)) {
            betterSqliteMembers.push(`${name ?? '<unknown>'}: ${renderedType}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    expect(dbMembers).toEqual([]);
    expect(betterSqliteMembers).toEqual([]);
  });

  it('keeps engine consumer bodies blind to raw sqlite and KB authority mutation surfaces', () => {
    const forbiddenCalls = [
      'writeIndex',
      'writeIndexState',
      'recordMutationCommitted',
      'recordIndexSyncSuccess',
      'recordReindexSuccess',
      'ensureCorpusFreshness',
    ];
    const forbiddenMembers = [
      'readIndex',
      'readIndexOrEmpty',
      'readIndexState',
      'readIndexStateIfPresent',
      'storagePort',
      'notePath',
      'sourcePath',
      'communityPath',
    ];
    const violations: string[] = [];

    for (const path of listSourceFiles(ENGINE_ROOT)) {
      const relativePath = relative(REPO_ROOT, path);
      const text = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

      for (const node of source.statements) {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === 'better-sqlite3'
        ) {
          violations.push(`${relativePath}: imports better-sqlite3`);
        }
      }

      const visit = (node: ts.Node): void => {
        if (ts.isIndexedAccessTypeNode(node) && /KbRuntime\s*\[\s*['"]db['"]\s*\]/.test(node.getText(source))) {
          violations.push(`${relativePath}: references KbRuntime['db']`);
        }

        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : ts.isIdentifier(callee)
              ? callee.text
              : null;
          if (name !== null && forbiddenCalls.includes(name)) {
            violations.push(`${relativePath}: calls ${name}`);
          }
        }

        if (ts.isPropertyAccessExpression(node)) {
          const name = node.name.text;
          const receiver = node.expression.getText(source);
          if (receiver === 'runtime' && name === 'db') {
            violations.push(`${relativePath}: reads runtime.db`);
          }
          if (forbiddenMembers.includes(name)) {
            violations.push(`${relativePath}: touches ${name}`);
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(violations).toEqual([]);
  });

  it('keeps the engine-facing KB runtime port free of authority readers and writers (full inheritance chain)', () => {
    const path = join(SRC_ROOT, 'kb/contract.ts');
    const source = sourceFile(path);
    const forbidden = new Set([
      'db',
      'writeIndex',
      'writeIndexState',
      'recordMutationCommitted',
      'recordIndexSyncSuccess',
      'recordReindexSuccess',
      'ensureCorpusFreshness',
      'readIndex',
      'readIndexOrEmpty',
      'readIndexState',
      'readIndexStateIfPresent',
      'storagePort',
      'notePath',
      'sourcePath',
      'communityPath',
    ]);

    const interfaceDecls = new Map<string, ts.InterfaceDeclaration>();
    const collect = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        interfaceDecls.set(node.name.text, node);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    const seen = new Set<string>();
    const violations: { interfaceName: string; member: string }[] = [];

    function walk(name: string): void {
      if (seen.has(name)) return;
      seen.add(name);
      const decl = interfaceDecls.get(name);
      if (decl === undefined) return;

      for (const member of decl.members) {
        if (
          (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
          member.name !== undefined
        ) {
          const memberName = propertyNameText(member.name);
          if (memberName !== null && forbidden.has(memberName)) {
            violations.push({ interfaceName: name, member: memberName });
          }
        }
      }

      for (const heritage of decl.heritageClauses ?? []) {
        if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const clause of heritage.types) {
          if (ts.isIdentifier(clause.expression)) {
            walk(clause.expression.text);
          }
        }
      }
    }

    walk('KbEngineRuntime');
    expect(violations).toEqual([]);
  });
});
