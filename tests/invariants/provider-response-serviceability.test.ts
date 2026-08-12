import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRODUCTION_FILES = listProductionSourceFiles(join(REPO_ROOT, 'src'));
const CANONICAL_PATHS = new Map(
  PRODUCTION_FILES.map((filePath) => [toCanonicalSrcPath(REPO_ROOT, filePath), filePath] as const),
);
const SERVICEABILITY_COMPOSITION = 'src/providers/serviceability.ts';
const TRANSPORT = 'src/providers/app-server-transport.ts';
const DIAGNOSTICS = 'src/providers/host-diagnostics.ts';
const COORDINATOR_OWNER = 'src/coordinator/live/provider-hosts/index.ts';
const COORDINATOR_SPAWNER = 'src/coordinator/live/admission.ts';
const PROXY_OWNER = 'src/provider-proxy/provider-root-authority.ts';
const CLASSIFIER_PATH = /^src\/providers\/([^/]+)\/serviceability\.ts$/u;
const SERVICEABILITY_LITERALS = new Set(['serviceable', 'unserviceable', 'unknown']);

function parse(relativePath: string): ts.SourceFile {
  const filePath = CANONICAL_PATHS.get(relativePath);
  if (filePath === undefined) throw new Error(`Missing production source ${relativePath}`);
  return ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(sourceFile: ts.Node, inspect: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    inspect(node);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

function isExported(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function exportedClassifierNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name !== undefined &&
    isExported(statement) &&
    statement.name.text.startsWith('classify')
      ? [statement.name.text]
      : [],
  );
}

function registeredClassifiers(): ReadonlyMap<string, string> {
  const sourceFile = parse(SERVICEABILITY_COMPOSITION);
  let registrations: ReadonlyMap<string, string> | undefined;
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text !== 'PROVIDER_RESPONSE_SERVICEABILITY_CLASSIFIERS' || node.initializer === undefined) return;
    const initializer =
      ts.isCallExpression(node.initializer) && node.initializer.arguments[0] !== undefined
        ? node.initializer.arguments[0]
        : node.initializer;
    if (!ts.isObjectLiteralExpression(initializer)) return;
    registrations = new Map(
      initializer.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.initializer)) return [];
        const provider =
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        return provider === undefined ? [] : [[provider, property.initializer.text] as const];
      }),
    );
  });
  return registrations ?? new Map();
}

function transportLayerViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  visit(sourceFile, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith('serviceability.js')
    ) {
      violations.push(
        `${TRANSPORT} must publish provider-response facts without deciding serviceability; forbidden import ${node.moduleSpecifier.text}`,
      );
    }
    if (ts.isStringLiteral(node) && SERVICEABILITY_LITERALS.has(node.text)) {
      violations.push(
        `${TRANSPORT} must publish provider-response facts without deciding serviceability; found verdict '${node.text}'`,
      );
    }
    if (
      ts.isIdentifier(node) &&
      (node.text === 'HostServiceability' ||
        node.text === 'reduceHostServiceability' ||
        /^classify.*Serviceability$/u.test(node.text))
    ) {
      violations.push(
        `${TRANSPORT} must publish provider-response facts without deciding serviceability; found ${node.text}`,
      );
    }
  });
  return [...new Set(violations)];
}

function propertyNames(typeAliasName: string, sourceFile: ts.SourceFile): string[] {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeAliasName,
  );
  if (declaration === undefined) return [];
  const type =
    ts.isTypeReferenceNode(declaration.type) && declaration.type.typeArguments?.[0] !== undefined
      ? declaration.type.typeArguments[0]
      : declaration.type;
  if (!ts.isTypeLiteralNode(type)) return [];
  return type.members.flatMap((member) =>
    ts.isPropertySignature(member) &&
    member.name !== undefined &&
    (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
      ? [member.name.text]
      : [],
  );
}

function callsNamed(sourceFile: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const calledName = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : undefined;
    if (calledName === name) calls.push(node);
  });
  return calls;
}

function objectArgumentHasProperty(call: ts.CallExpression, propertyName: string): boolean {
  const object = call.arguments.find(ts.isObjectLiteralExpression);
  return (
    object?.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        property.name.getText() === propertyName,
    ) ?? false
  );
}

describe('provider response serviceability decision layers', () => {
  it('keeps the canonical fact host-local and complete without embedding HostRef', () => {
    const diagnostics = parse(DIAGNOSTICS);
    expect(propertyNames('ProviderResponseDiagnosticFact', diagnostics).sort()).toEqual(
      ['factSeq', 'generation', 'hostLog', 'method', 'requestId', 'response'].sort(),
    );
    expect(diagnostics.getText()).not.toMatch(/ProviderResponseDiagnosticFact[\s\S]{0,500}\bHostRef\b/u);
  });

  it('requires the transport layer to publish facts without deciding serviceability', () => {
    expect(transportLayerViolations(parse(TRANSPORT))).toEqual([]);
  });

  it('publishes once from the completed-response path before resolving or rejecting the request', () => {
    const transport = parse(TRANSPORT);
    const responseHandler = transport.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'handleProviderServerLine',
    );
    expect(responseHandler).toBeDefined();
    const observations = callsNamed(responseHandler as ts.FunctionDeclaration, 'observeProviderResponse');
    expect(observations).toHaveLength(1);
    const observationPosition = observations[0]?.getStart() ?? Number.POSITIVE_INFINITY;
    const settlements = [
      ...callsNamed(responseHandler as ts.FunctionDeclaration, 'resolve'),
      ...callsNamed(responseHandler as ts.FunctionDeclaration, 'reject'),
    ].filter((call) => call.expression.getText().startsWith('pending.'));
    expect(settlements.length).toBeGreaterThan(0);
    expect(settlements.every((call) => observationPosition < call.getStart())).toBe(true);
  });

  it('registers every provider-owned classifier and inventories every registration', () => {
    const classifierFiles = [...CANONICAL_PATHS.keys()].flatMap((path) => {
      const match = CLASSIFIER_PATH.exec(path);
      return match?.[1] === undefined ? [] : [{ provider: match[1], path, sourceFile: parse(path) }];
    });
    const registrations = registeredClassifiers();
    const violations = classifierFiles.flatMap(({ provider, path, sourceFile }) => {
      const exports = exportedClassifierNames(sourceFile);
      if (exports.length === 0) return [`${path} must export a provider response serviceability classifier`];
      const registered = registrations.get(provider);
      return registered !== undefined && exports.includes(registered)
        ? []
        : [`${path} classifier must be registered for provider '${provider}'`];
    });
    for (const [provider, classifier] of registrations) {
      const sourceFile = classifierFiles.find((entry) => entry.provider === provider);
      if (sourceFile === undefined || !exportedClassifierNames(sourceFile.sourceFile).includes(classifier)) {
        violations.push(`registered classifier ${provider}:${classifier} is absent from the classifier inventory`);
      }
    }

    expect(classifierFiles.length).toBeGreaterThan(0);
    expect(registrations.size).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('forbids every provider classifier from interpreting providerMessage prose', () => {
    const violations = [...CANONICAL_PATHS.keys()].flatMap((path) => {
      if (!CLASSIFIER_PATH.test(path)) return [];
      const identifiers: string[] = [];
      visit(parse(path), (node) => {
        if (ts.isIdentifier(node) && node.text === 'providerMessage') identifiers.push(node.text);
        if (ts.isStringLiteral(node) && node.text === 'providerMessage') identifiers.push(node.text);
      });
      return identifiers.length === 0
        ? []
        : [`${path} must classify from typed method/code/data fields, never providerMessage prose`];
    });
    expect(violations).toEqual([]);
  });

  it('wires a live sink through both host owners and the coordinator spawn forwarder', () => {
    const edges = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILES);
    const importers = edges
      .filter((edge) => edge.runtime && edge.target === SERVICEABILITY_COMPOSITION)
      .map((edge) => edge.source)
      .sort();
    expect(importers).toEqual([COORDINATOR_OWNER, PROXY_OWNER].sort());

    const coordinatorOwnerCalls = callsNamed(parse(COORDINATOR_OWNER), 'spawnProviderServer');
    expect(coordinatorOwnerCalls.some((call) => call.arguments.length === 2)).toBe(true);
    const coordinatorTransportCalls = callsNamed(parse(COORDINATOR_SPAWNER), 'spawnProviderServerTransport');
    expect(coordinatorTransportCalls.some((call) => objectArgumentHasProperty(call, 'observeProviderResponse'))).toBe(
      true,
    );
    const proxyTransportCalls = callsNamed(parse(PROXY_OWNER), 'spawnProviderServerTransport');
    expect(proxyTransportCalls.some((call) => objectArgumentHasProperty(call, 'observeProviderResponse'))).toBe(true);
  });

  it('guards both owner sinks by reserved slot, exact ref, and transport generation', () => {
    const coordinator = parse(COORDINATOR_OWNER).getText();
    expect(coordinator).toContain('this.entries.get(entry.hostKey) !== entry');
    expect(coordinator).toContain('hostRefsMatch(hostRefFromEntry(entry), expectedRef)');
    expect(coordinator).toContain('handle.generation !== fact.generation');

    const proxy = parse(PROXY_OWNER).getText();
    expect(proxy).toContain('entries.get(hostKey) !== candidate');
    expect(proxy).toContain('isMatchingHostRef(reservedRef, candidate, runtime)');
    expect(proxy).toContain('candidate.handle.generation !== fact.generation');
  });
});
