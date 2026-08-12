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
const SERVICEABILITY_COMPOSITION = 'src/providers/bootstrap.ts';
const SERVICEABILITY_SEAM = 'src/providers/serviceability.ts';
const TRANSPORT = 'src/providers/app-server-transport.ts';
const DIAGNOSTICS = 'src/providers/host-diagnostics.ts';
const ADMISSION = 'src/providers/host-admission.ts';
const SERVICEABILITY_REDUCER = 'src/providers/host-serviceability.ts';
const COORDINATOR_ADMISSION_LEAF = 'src/coordinator/live/provider-host-admission.ts';
const PROXY_ADMISSION_LEAF = 'src/provider-proxy/provider-host-admission.ts';
const COORDINATOR_OWNER = 'src/coordinator/live/provider-hosts/index.ts';
const COORDINATOR_SPAWNER = 'src/coordinator/live/admission.ts';
const PROXY_OWNER = 'src/provider-proxy/provider-root-authority.ts';
const CLASSIFIER_PATH = /^src\/providers\/([^/]+)\/serviceability\.ts$/u;
const SERVICEABILITY_LITERALS = new Set(['serviceable', 'unserviceable', 'unknown']);

type DecisionSymbol = Readonly<{ path: string; symbol: string }>;

const STATIC_DECISION_SYMBOLS = {
  factPublishers: [
    { path: DIAGNOSTICS, symbol: 'recordProviderResponseDiagnostic' },
    { path: TRANSPORT, symbol: 'handleProviderServerLine' },
  ],
  classifierDispatchers: [
    { path: SERVICEABILITY_COMPOSITION, symbol: 'classifyProviderResponseServiceability' },
    { path: SERVICEABILITY_SEAM, symbol: 'classifyProviderResponseServiceability' },
  ],
  serviceabilityReducers: [{ path: SERVICEABILITY_REDUCER, symbol: 'reduceHostServiceability' }],
  admissionSymbols: [
    { path: ADMISSION, symbol: 'reduceHostAdmission' },
    { path: ADMISSION, symbol: 'createHostAdmissionCollection' },
  ],
  admissionCompositionLeaves: [
    { path: COORDINATOR_ADMISSION_LEAF, symbol: 'createCoordinatorProviderHostAdmission' },
    { path: PROXY_ADMISSION_LEAF, symbol: 'createProxyProviderHostAdmission' },
  ],
} satisfies Readonly<Record<string, readonly DecisionSymbol[]>>;

const FORBIDDEN_CLASSIFIER_EVIDENCE = new Set([
  'providerMessage',
  'factSeq',
  'generation',
  'requestId',
  'hostLog',
  'startSeq',
  'endSeq',
]);

const FORBIDDEN_DECISION_BOUND_TOKENS = new Set([
  'age',
  'attempt',
  'attempts',
  'clock',
  'consecutive',
  'count',
  'counter',
  'deadline',
  'duration',
  'elapsed',
  'expired',
  'expiry',
  'failures',
  'hrtime',
  'millisecond',
  'milliseconds',
  'monotonic',
  'ms',
  'now',
  'retry',
  'streak',
  'time',
  'timeout',
  'timestamp',
  'uptime',
]);

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

function classifierFiles(): ReadonlyArray<{ provider: string; path: string; sourceFile: ts.SourceFile }> {
  return [...CANONICAL_PATHS.keys()].flatMap((path) => {
    const match = CLASSIFIER_PATH.exec(path);
    return match?.[1] === undefined ? [] : [{ provider: match[1], path, sourceFile: parse(path) }];
  });
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

function namedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function isForbiddenDecisionBoundName(name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.some((token) => FORBIDDEN_DECISION_BOUND_TOKENS.has(token))) return true;
  if (tokens.includes('budget') && tokens.includes('retry')) return true;
  if (tokens.includes('failure') && (tokens.includes('count') || tokens.includes('counter'))) return true;
  return /(?:observed|started|finished|created|updated)_at/u.test(tokens.join('_'));
}

function decisionBoundViolations(spec: DecisionSymbol): string[] {
  const sourceFile = parse(spec.path);
  const declaration = namedFunction(sourceFile, spec.symbol);
  if (declaration === undefined) return [`${spec.path}:${spec.symbol} is absent from the decision closure`];

  const violations: string[] = [];
  const report = (node: ts.Node, detail: string): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${spec.path}:${spec.symbol}:${line + 1}:${character + 1} ${detail}`);
  };
  visit(declaration, (node) => {
    if (ts.isIdentifier(node) && isForbiddenDecisionBoundName(node.text)) {
      report(node, `references forbidden decision-bound symbol '${node.text}'`);
    }
    if (ts.isStringLiteralLike(node) && isForbiddenDecisionBoundName(node.text)) {
      report(node, `references forbidden decision-bound text '${node.text}'`);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      report(node, `mutates a decision counter with '${node.getText(sourceFile)}'`);
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.PlusEqualsToken,
        ts.SyntaxKind.MinusEqualsToken,
        ts.SyntaxKind.AsteriskEqualsToken,
        ts.SyntaxKind.SlashEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      report(node, `mutates decision state arithmetically with '${node.getText(sourceFile)}'`);
    }
  });
  return [...new Set(violations)];
}

function decisionClosureInventory(): Readonly<Record<string, readonly DecisionSymbol[]>> {
  return {
    ...STATIC_DECISION_SYMBOLS,
    providerClassifiers: classifierFiles().flatMap(({ path, sourceFile }) =>
      exportedClassifierNames(sourceFile).map((symbol) => ({ path, symbol })),
    ),
  };
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
    expect(propertyNames('ProviderHostLogCursorSpan', diagnostics).sort()).toEqual(['endSeq', 'startSeq']);
    expect(
      [
        ...propertyNames('ProviderResponseDiagnosticFact', diagnostics),
        ...propertyNames('ProviderHostLogCursorSpan', diagnostics),
      ].filter(isForbiddenDecisionBoundName),
    ).toEqual([]);
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
    const classifiers = classifierFiles();
    const registrations = registeredClassifiers();
    const violations = classifiers.flatMap(({ provider, path, sourceFile }) => {
      const exports = exportedClassifierNames(sourceFile);
      if (exports.length === 0) return [`${path} must export a provider response serviceability classifier`];
      const registered = registrations.get(provider);
      return registered !== undefined && exports.includes(registered)
        ? []
        : [`${path} classifier must be registered for provider '${provider}'`];
    });
    for (const [provider, classifier] of registrations) {
      const sourceFile = classifiers.find((entry) => entry.provider === provider);
      if (sourceFile === undefined || !exportedClassifierNames(sourceFile.sourceFile).includes(classifier)) {
        violations.push(`registered classifier ${provider}:${classifier} is absent from the classifier inventory`);
      }
    }

    expect(classifiers.length).toBeGreaterThan(0);
    expect(registrations.size).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('limits every provider classifier to typed method/code/data evidence, never providerMessage prose', () => {
    const violations = classifierFiles().flatMap(({ path, sourceFile }) => {
      const forbiddenEvidence: string[] = [];
      visit(sourceFile, (node) => {
        if (ts.isIdentifier(node) && FORBIDDEN_CLASSIFIER_EVIDENCE.has(node.text)) {
          forbiddenEvidence.push(node.text);
        }
        if (ts.isStringLiteral(node) && FORBIDDEN_CLASSIFIER_EVIDENCE.has(node.text)) {
          forbiddenEvidence.push(node.text);
        }
      });
      return forbiddenEvidence.length === 0
        ? []
        : [
            `${path} must classify from typed method/code/data fields, never providerMessage prose or host-local cursors: ${[
              ...new Set(forbiddenEvidence),
            ].join(', ')}`,
          ];
    });
    expect(violations).toEqual([]);
  });

  it('inventories every non-empty serviceability decision category and every named symbol', () => {
    const inventory = decisionClosureInventory();
    expect(Object.keys(inventory).length).toBeGreaterThan(0);
    expect(Object.entries(inventory).filter(([, symbols]) => symbols.length === 0)).toEqual([]);
    expect(STATIC_DECISION_SYMBOLS.admissionCompositionLeaves).toHaveLength(2);

    const missingSymbols = Object.values(inventory)
      .flat()
      .flatMap((spec) =>
        namedFunction(parse(spec.path), spec.symbol) === undefined ? [`${spec.path}:${spec.symbol}`] : [],
      );
    expect(missingSymbols).toEqual([]);

    const classifierSymbols = new Set(inventory.providerClassifiers?.map((spec) => spec.symbol) ?? []);
    const uninventoriedRegistrations = [...registeredClassifiers()].flatMap(([provider, classifier]) =>
      classifierSymbols.has(classifier) ? [] : [`${provider}:${classifier}`],
    );
    expect(uninventoriedRegistrations).toEqual([]);
  });

  it('keeps every classifier, reducer, admission symbol, and composition leaf free of clocks and numeric bounds', () => {
    const decisionSymbols = Object.entries(decisionClosureInventory())
      .filter(([category]) => category !== 'factPublishers')
      .flatMap(([, symbols]) => symbols);
    const violations = decisionSymbols.flatMap(decisionBoundViolations);
    expect(violations).toEqual([]);
  });

  it('wires a live sink through both host owners and the coordinator spawn forwarder', () => {
    const edges = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILES);
    const importers = edges
      .filter((edge) => edge.runtime && edge.target === SERVICEABILITY_SEAM)
      .map((edge) => edge.source)
      .sort();
    expect(importers).toEqual([COORDINATOR_ADMISSION_LEAF, PROXY_ADMISSION_LEAF].sort());

    const admissionLeafImporters = edges
      .filter(
        (edge) => edge.runtime && (edge.target === COORDINATOR_ADMISSION_LEAF || edge.target === PROXY_ADMISSION_LEAF),
      )
      .map((edge) => edge.source)
      .sort();
    expect(admissionLeafImporters).toEqual([COORDINATOR_OWNER, PROXY_OWNER].sort());

    const coordinatorOwnerCalls = callsNamed(parse(COORDINATOR_OWNER), 'spawnProviderServer');
    expect(coordinatorOwnerCalls.some((call) => call.arguments.length === 3)).toBe(true);
    const coordinatorTransportCalls = callsNamed(parse(COORDINATOR_SPAWNER), 'spawnProviderServerTransport');
    expect(coordinatorTransportCalls.some((call) => objectArgumentHasProperty(call, 'observeProviderResponse'))).toBe(
      true,
    );
    const proxyTransportCalls = callsNamed(parse(PROXY_OWNER), 'spawnProviderServerTransport');
    expect(proxyTransportCalls.some((call) => objectArgumentHasProperty(call, 'observeProviderResponse'))).toBe(true);
  });

  it('guards both owner sinks by reserved slot, exact ref, and transport generation', () => {
    expect(parse(COORDINATOR_OWNER).getText()).toContain('this.admission.observe(admission.slot, hostRef, fact)');
    expect(parse(PROXY_OWNER).getText()).toContain('admission.observe(placement.slot, reservedRef, fact)');

    const admission = parse(ADMISSION).getText();
    expect(admission).toContain('matchingCandidate(state, slot, ref, fact.generation)');
    expect(admission).toContain('exactHostRefsMatch(placement.ref, ref)');
    expect(admission).toContain('current.generation === generation && exactHostRefsMatch(current.ref, ref)');
  });
});
