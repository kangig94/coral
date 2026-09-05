import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');

type CapabilitySpec = Readonly<{
  typeName: string;
  ownerFile: string;
  constructorName: string;
  sinkName: string;
  sinkParameterIndex: number;
  negativeFixture: string;
}>;

const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    typeName: 'HandoffSignalCapability',
    ownerFile: 'src/coordinator/handoff.ts',
    constructorName: 'verifySignalTarget',
    sinkName: 'signalIncumbent',
    sinkParameterIndex: 1,
    negativeFixture: `
      type HandoffSignalCapability = Readonly<{ kind: 'alive' }>;
      function verifySignalTarget() { return {} as HandoffSignalCapability; }
      function signalIncumbent(opts: unknown, capability: HandoffSignalCapability) {}
      function counterfeit() { return {} as HandoffSignalCapability; }
    `,
  },
  {
    typeName: 'DurableContainmentAbsenceCapability',
    ownerFile: 'src/coordinator/live/durable-transport.ts',
    constructorName: 'resolveDurableProcessContainment',
    sinkName: 'releaseCleanupOwnership',
    sinkParameterIndex: 0,
    negativeFixture: `
      type DurableContainmentAbsenceCapability = Readonly<{ kind: 'observed-absent' }>;
      function resolveDurableProcessContainment() { return {} as DurableContainmentAbsenceCapability; }
      const releaseCleanupOwnership = (absence: DurableContainmentAbsenceCapability) => {};
      function counterfeit() { return {} as DurableContainmentAbsenceCapability; }
    `,
  },
  {
    typeName: 'RecoveryCommitReceipt',
    ownerFile: 'src/coordinator/services/recovery/interrupted-finalizer.ts',
    constructorName: 'finalizeSessionExact',
    sinkName: 'exportResultAndReleaseOwnership',
    sinkParameterIndex: 0,
    negativeFixture: `
      type RecoveryCommitReceipt = Readonly<{ committed: true }>;
      function finalizeSessionExact() { return {} as RecoveryCommitReceipt; }
      function exportResultAndReleaseOwnership(receipt: RecoveryCommitReceipt) {}
      function counterfeit() { return {} as RecoveryCommitReceipt; }
    `,
  },
];

type SourceUnit = Readonly<{ file: string; source: ts.SourceFile }>;

function parse(file: string, text: string): SourceUnit {
  return { file, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? null;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return null;
}

function namedParameters(node: ts.Node, name: string): readonly ts.ParameterDeclaration[] | null {
  if (ts.isFunctionDeclaration(node) && node.name?.text === name) return node.parameters;
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === name &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.initializer.parameters;
  }
  return null;
}

function namesType(type: ts.TypeNode | undefined, typeName: string): boolean {
  if (type === undefined) return false;
  let found = false;
  walk(type, (node) => {
    if (ts.isTypeReferenceNode(node) && node.typeName.getText(type.getSourceFile()) === typeName) found = true;
  });
  return found;
}

function analyzeCapability(spec: CapabilitySpec, units: readonly SourceUnit[]): readonly string[] {
  const violations: string[] = [];
  let authorizedMintFound = false;
  let sinkFound = false;

  for (const unit of units) {
    walk(unit.source, (node) => {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        node.type.getText(unit.source) === spec.typeName
      ) {
        const owner = enclosingFunctionName(node);
        if (unit.file === spec.ownerFile && owner === spec.constructorName) authorizedMintFound = true;
        else violations.push(`${spec.typeName} is minted by ${unit.file}:${owner ?? '<module>'}`);
      }

      if (unit.file !== spec.ownerFile) return;
      const parameters = namedParameters(node, spec.sinkName);
      if (parameters === null) return;
      sinkFound = true;
      if (!namesType(parameters[spec.sinkParameterIndex]?.type, spec.typeName)) {
        violations.push(`${spec.sinkName} does not require ${spec.typeName}`);
      }
    });
  }

  if (!authorizedMintFound) violations.push(`${spec.constructorName} does not mint ${spec.typeName}`);
  if (!sinkFound) violations.push(`${spec.sinkName} is missing`);
  return violations;
}

function productionUnits(): readonly SourceUnit[] {
  return listProductionSourceFiles(SRC_ROOT).map((absolutePath) => {
    const file = relative(REPO_ROOT, absolutePath).split(sep).join('/');
    return parse(file, readFileSync(absolutePath, 'utf8'));
  });
}

describe('finalization capability authority', () => {
  it('keeps capability minting and consumption at the verified finalization seams', () => {
    const units = productionUnits();
    expect(CAPABILITIES.flatMap((spec) => analyzeCapability(spec, units))).toEqual([]);
  });

  it.each(CAPABILITIES)('rejects unauthorized $typeName minting', (spec) => {
    const violations = analyzeCapability(spec, [parse(spec.ownerFile, spec.negativeFixture)]);
    expect(violations).toContain(`${spec.typeName} is minted by ${spec.ownerFile}:counterfeit`);
  });
});
