/**
 * Carrier observability deliberately excludes `jobs.list` and `jobs.detail`.
 * These read contracts stay carrier-free and synchronous so observation does
 * not turn established local reads into network-dependent operations.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const PORTS_FILE = join(REPO_ROOT, 'src/transport/rpc/ports.ts');
const CORAL_STORE_FILE = join(REPO_ROOT, 'src/read-model/coral-store.ts');

function parse(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, readFileSync(filePath, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function declarationName(node: { name?: ts.PropertyName }): string | null {
  const { name } = node;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function interfaceMethod(
  sourceFile: ts.SourceFile,
  interfaceName: string,
  methodName: string,
): ts.MethodSignature | undefined {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  );
  return declaration?.members.find(
    (member): member is ts.MethodSignature => ts.isMethodSignature(member) && declarationName(member) === methodName,
  );
}

function classProperty(
  sourceFile: ts.SourceFile,
  className: string,
  propertyName: string,
): ts.PropertyDeclaration | undefined {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  return declaration?.members.find(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && declarationName(member) === propertyName,
  );
}

function functionPropertyReturnType(
  property: ts.PropertyDeclaration | undefined,
  memberName: string,
): ts.TypeNode | undefined {
  if (property?.type === undefined || !ts.isTypeLiteralNode(property.type)) return undefined;
  const member = property.type.members.find(
    (candidate): candidate is ts.PropertySignature =>
      ts.isPropertySignature(candidate) && declarationName(candidate) === memberName,
  );
  return member?.type !== undefined && ts.isFunctionTypeNode(member.type) ? member.type.type : undefined;
}

function normalizedType(type: ts.TypeNode): string {
  return type.getText().replace(/\s+/gu, ' ').trim();
}

function expectSynchronousJobsRead(type: ts.TypeNode | undefined, signature: string, expected: string): void {
  const diagnostic =
    `${signature} must remain a synchronous jobs read returning ${expected}; ` +
    'carrier fields and Promise returns are out of scope';
  expect(type, diagnostic).toBeDefined();
  if (type === undefined) return;
  expect(normalizedType(type), diagnostic).toBe(expected);
}

describe('jobs read contracts stay synchronous and carrier-free', () => {
  const ports = parse(PORTS_FILE);
  const coralStore = parse(CORAL_STORE_FILE);
  const jobs = classProperty(coralStore, 'CoralStore', 'jobs');

  it('pins JobsRequestPort.list as a synchronous jobs read', () => {
    expectSynchronousJobsRead(
      interfaceMethod(ports, 'JobsRequestPort', 'list')?.type,
      'JobsRequestPort.list',
      'Array<{ jobId: string; status: JobStatus }>',
    );
  });

  it('pins JobsRequestPort.detail as a synchronous jobs read', () => {
    expectSynchronousJobsRead(
      interfaceMethod(ports, 'JobsRequestPort', 'detail')?.type,
      'JobsRequestPort.detail',
      'JobDetailResponse | null',
    );
  });

  it('pins CoralStore.jobs.list as a synchronous jobs read', () => {
    expectSynchronousJobsRead(
      functionPropertyReturnType(jobs, 'list'),
      'CoralStore.jobs.list',
      "Array<{ jobId: string; status: JobDetail['status'] }>",
    );
  });

  it('pins CoralStore.jobs.detail as a synchronous jobs read', () => {
    expectSynchronousJobsRead(functionPropertyReturnType(jobs, 'detail'), 'CoralStore.jobs.detail', 'JobDetail | null');
  });
});
