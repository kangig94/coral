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
import {
  analyzeCallableClosure,
  createCallableClosureContext,
  exportedClassifierNames,
  providerClassifierFiles,
  serviceabilityDecisionClosureAnalysis,
  STATIC_SERVICEABILITY_DECISION_SYMBOLS,
  type CallableClosureAnalysis,
  type ResolvedCallable,
} from './provider-serviceability-decision-inventory.js';
import {
  activeServiceabilityMutation,
  fixturePath,
  serviceabilityMutationFixtureContext,
} from './provider-serviceability-call-closure-fixture.js';

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
const COORDINATOR_ADMISSION_LEAF = 'src/coordinator/live/provider-host-admission.ts';
const COORDINATOR_COMPOSITION = 'src/coordinator/index.ts';
const PROXY_ADMISSION_LEAF = 'src/provider-proxy/provider-host-admission.ts';
const COORDINATOR_OWNER = 'src/coordinator/live/provider-hosts/index.ts';
const COORDINATOR_SPAWNER = 'src/coordinator/live/admission.ts';
const PROXY_OWNER = 'src/provider-proxy/provider-root-authority.ts';
const SERVICEABILITY_LITERALS = new Set(['serviceable', 'unserviceable', 'unknown']);
const CALLABLE_CONTEXT = createCallableClosureContext(REPO_ROOT, PRODUCTION_FILES);
const DECISION_CLOSURE_ANALYSIS = serviceabilityDecisionClosureAnalysis(REPO_ROOT, PRODUCTION_FILES, CALLABLE_CONTEXT);
const TRANSPORT_FACT_RETENTION_EXCLUSIONS = new Set([`${DIAGNOSTICS}#retainProviderResponseDiagnostic`]);
/**
 * This fact guard starts at the completed-response publisher and scans every checker-resolved project callable
 * reached through calls, constructors, and individual callable leaves in statically decomposable callback
 * containers. It scans both host-log cursor reads and response-fact construction. Its only exclusion is the exact
 * `retainProviderResponseDiagnostic` helper, which receives an already-constructed fact and only advances its
 * sequence before retaining and evicting completed observations. Imported construction helpers such as
 * `copyResponse` remain scanned, every unresolved project edge fails closed, and the test asserts non-vacuity over
 * the resolved guarded set.
 */
const TRANSPORT_FACT_ANALYSIS = analyzeCallableClosure(CALLABLE_CONTEXT, [
  { path: TRANSPORT, symbol: 'handleProviderServerResponse' },
]);
const MUTATION_FIXTURE_CONTEXT = serviceabilityMutationFixtureContext();

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

function classifierFiles(): ReadonlyArray<{ provider: string; path: string; sourceFile: ts.SourceFile }> {
  return providerClassifierFiles(REPO_ROOT, PRODUCTION_FILES);
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

function decisionBoundViolations(callable: ResolvedCallable): string[] {
  const { path, symbol, sourceFile, node: declaration } = callable;
  const violations: string[] = [];
  const report = (node: ts.Node, detail: string): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${path}:${symbol}:${line + 1}:${character + 1} ${detail}`);
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

function decisionClosureInventory(): Readonly<Record<string, readonly ResolvedCallable[]>> {
  return Object.fromEntries(
    Object.entries(DECISION_CLOSURE_ANALYSIS).map(([category, analysis]) => [category, analysis.callables]),
  );
}

function guardedTransportFactCallables(analysis: CallableClosureAnalysis): readonly ResolvedCallable[] {
  return analysis.callables.filter(({ path, symbol }) => !TRANSPORT_FACT_RETENTION_EXCLUSIONS.has(`${path}#${symbol}`));
}

const DECISION_CLOSURE_MUTATIONS = [
  {
    id: 'imported-helper-clock',
    root: { path: fixturePath('imported-root.ts'), symbol: 'importedRoot' },
    target: { path: fixturePath('imported-helper.ts'), symbol: 'importedDecisionHelper' },
    signature: "references forbidden decision-bound symbol 'now'",
  },
  {
    id: 'method-counter',
    root: { path: fixturePath('method-root.ts'), symbol: 'methodRoot' },
    target: { path: fixturePath('method-root.ts'), symbol: 'MethodDecision.evaluate' },
    signature: "references forbidden decision-bound symbol 'attemptCount'",
  },
  {
    id: 'callback-retry-budget',
    root: { path: fixturePath('callback-root.ts'), symbol: 'callbackRoot' },
    target: { path: fixturePath('callback-root.ts'), symbol: 'callbackDecision' },
    signature: "references forbidden decision-bound symbol 'retryBudget'",
  },
  {
    id: 'constructor-clock',
    root: { path: fixturePath('constructor-root.ts'), symbol: 'constructorRoot' },
    target: { path: fixturePath('constructor-root.ts'), symbol: 'ConstructorDecision.constructor' },
    signature: "references forbidden decision-bound symbol 'now'",
  },
] as const;

const TRANSPORT_FACT_CLOSURE_MUTATIONS = [
  {
    id: 'transport-fact-counter',
    root: { path: fixturePath('transport-fact-root.ts'), symbol: 'handleProviderServerResponse' },
    signature: "references forbidden decision-bound symbol 'elapsedMs'",
  },
  {
    id: 'imported-transport-fact-counter',
    root: {
      path: fixturePath('transport-fact-imported-root.ts'),
      symbol: 'handleImportedProviderServerResponse',
    },
    signature: "references forbidden decision-bound symbol 'elapsedMs'",
  },
] as const;

const CALLABLE_RESOLUTION_MUTATIONS = [
  {
    id: 'mixed-container-unresolved-callback',
    root: { path: fixturePath('mixed-container-root.ts'), symbol: 'mixedContainerRoot' },
    resolvedTarget: { path: fixturePath('mixed-container-root.ts'), symbol: 'resolvedCallback' },
    signature: "argument 1 'unresolved' has callable type but no resolvable target",
  },
] as const;

function decisionClosureMutationViolations(mutation: (typeof DECISION_CLOSURE_MUTATIONS)[number]): readonly string[] {
  const analysis = analyzeCallableClosure(MUTATION_FIXTURE_CONTEXT, [mutation.root]);
  if (analysis.unresolvedCalls.length > 0) return analysis.unresolvedCalls;
  const target = analysis.callables.find(
    ({ path, symbol }) => path === mutation.target.path && symbol === mutation.target.symbol,
  );
  return target === undefined
    ? [`${mutation.target.path}#${mutation.target.symbol} was not resolved`]
    : decisionBoundViolations(target);
}

function transportFactMutationViolations(
  mutation: (typeof TRANSPORT_FACT_CLOSURE_MUTATIONS)[number],
): readonly string[] {
  const analysis = analyzeCallableClosure(MUTATION_FIXTURE_CONTEXT, [mutation.root]);
  if (analysis.unresolvedCalls.length > 0) return analysis.unresolvedCalls;
  const callables = guardedTransportFactCallables(analysis);
  return callables.length === 0
    ? [`${mutation.root.path}#${mutation.root.symbol} resolved no guarded callables`]
    : callables.flatMap(decisionBoundViolations);
}

function callableResolutionMutationAnalysis(
  mutation: (typeof CALLABLE_RESOLUTION_MUTATIONS)[number],
): CallableClosureAnalysis {
  return analyzeCallableClosure(MUTATION_FIXTURE_CONTEXT, [mutation.root]);
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
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'handleProviderServerResponse',
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

  it('resolves a non-vacuous transitive serviceability decision closure across project calls and callbacks', () => {
    const inventory = decisionClosureInventory();
    expect(Object.keys(inventory).length).toBeGreaterThan(0);
    expect(Object.entries(inventory).filter(([, symbols]) => symbols.length === 0)).toEqual([]);
    expect(STATIC_SERVICEABILITY_DECISION_SYMBOLS.admissionCompositionLeaves).toHaveLength(3);
    expect(inventory.admissionSymbols?.map((spec) => spec.symbol)).toEqual(
      expect.arrayContaining(['hostAdmissionForPhase', 'assertFreshPlacementAllowed', 'observeProviderResponse']),
    );

    const analyses = Object.values(DECISION_CLOSURE_ANALYSIS);
    expect(analyses.flatMap(({ unresolvedCalls }) => unresolvedCalls)).toEqual([]);
    expect(analyses.reduce((count, { inspectedCallCount }) => count + inspectedCallCount, 0)).toBeGreaterThan(0);
    expect(analyses.flatMap(({ edges }) => edges).length).toBeGreaterThan(0);
    expect(
      analyses.flatMap(({ edges }) => edges).filter(({ from, to }) => from.path !== to.path).length,
    ).toBeGreaterThan(0);
    expect(analyses.flatMap(({ edges }) => edges).filter(({ kind }) => kind === 'callback').length).toBeGreaterThan(0);
    expect(
      new Set(
        Object.values(inventory)
          .flat()
          .map(({ path, symbol }) => `${path}#${symbol}`),
      ).size,
    ).toBeGreaterThan(
      new Set(
        Object.values(STATIC_SERVICEABILITY_DECISION_SYMBOLS)
          .flat()
          .map(({ path, symbol }) => `${path}#${symbol}`),
      ).size,
    );

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

  it('keeps the completed-response transport fact closure free of clocks and numeric bounds', () => {
    expect(TRANSPORT_FACT_ANALYSIS.unresolvedCalls).toEqual([]);
    expect(TRANSPORT_FACT_ANALYSIS.callables.length).toBeGreaterThan(0);
    expect(TRANSPORT_FACT_ANALYSIS.inspectedCallCount).toBeGreaterThan(0);
    expect(TRANSPORT_FACT_ANALYSIS.edges.length).toBeGreaterThan(0);
    expect(TRANSPORT_FACT_ANALYSIS.callables.map(({ path, symbol }) => `${path}#${symbol}`)).toEqual(
      expect.arrayContaining([
        `${DIAGNOSTICS}#currentProviderHostLogSeq`,
        `${DIAGNOSTICS}#recordProviderResponseDiagnostic`,
        ...TRANSPORT_FACT_RETENTION_EXCLUSIONS,
      ]),
    );
    expect(
      TRANSPORT_FACT_ANALYSIS.callables
        .map(({ path, symbol }) => `${path}#${symbol}`)
        .filter((key) => TRANSPORT_FACT_RETENTION_EXCLUSIONS.has(key))
        .sort(),
    ).toEqual([...TRANSPORT_FACT_RETENTION_EXCLUSIONS].sort());
    const guardedCallables = guardedTransportFactCallables(TRANSPORT_FACT_ANALYSIS);
    expect(guardedCallables.length).toBeGreaterThan(0);
    expect(guardedCallables.flatMap(decisionBoundViolations)).toEqual([]);
  });

  it.each(DECISION_CLOSURE_MUTATIONS)(
    'rejects the $id mutation through its own resolved callable signature',
    (mutation) => {
      const violations = decisionClosureMutationViolations(mutation);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((violation) => violation.includes(mutation.signature))).toBe(true);
    },
  );

  it.each(TRANSPORT_FACT_CLOSURE_MUTATIONS)(
    'rejects the $id mutation through the transitive transport-fact guard',
    (mutation) => {
      const violations = transportFactMutationViolations(mutation);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((violation) => violation.includes(mutation.signature))).toBe(true);
    },
  );

  it.each(CALLABLE_RESOLUTION_MUTATIONS)(
    'rejects the $id mutation while retaining its resolved sibling callback',
    (mutation) => {
      const analysis = callableResolutionMutationAnalysis(mutation);
      expect(analysis.callables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: mutation.resolvedTarget.path, symbol: mutation.resolvedTarget.symbol }),
        ]),
      );
      expect(
        analysis.edges.some(
          ({ kind, to }) =>
            kind === 'callback' &&
            to.path === mutation.resolvedTarget.path &&
            to.symbol === mutation.resolvedTarget.symbol,
        ),
      ).toBe(true);
      expect(analysis.unresolvedCalls).toEqual([expect.stringContaining(mutation.signature)]);
    },
  );

  it('fails closed when an imported project callee has no checker-resolved implementation', () => {
    const analysis = analyzeCallableClosure(MUTATION_FIXTURE_CONTEXT, [
      { path: fixturePath('unresolved-root.ts'), symbol: 'unresolvedRoot' },
    ]);
    expect(analysis.inspectedCallCount).toBeGreaterThan(0);
    expect(analysis.unresolvedCalls).toEqual([
      expect.stringContaining(`${fixturePath('unresolved-root.ts')}#unresolvedRoot`),
    ]);
  });

  it('keeps the opt-in decision-closure mutation probe clean', () => {
    const activeMutation = activeServiceabilityMutation();
    const decisionMutation = DECISION_CLOSURE_MUTATIONS.find(({ id }) => id === activeMutation);
    const transportMutation = TRANSPORT_FACT_CLOSURE_MUTATIONS.find(({ id }) => id === activeMutation);
    const callableResolutionMutation = CALLABLE_RESOLUTION_MUTATIONS.find(({ id }) => id === activeMutation);
    const violations =
      decisionMutation !== undefined
        ? decisionClosureMutationViolations(decisionMutation)
        : transportMutation !== undefined
          ? transportFactMutationViolations(transportMutation)
          : callableResolutionMutation === undefined
            ? []
            : callableResolutionMutationAnalysis(callableResolutionMutation).unresolvedCalls;
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
    expect(admissionLeafImporters).toEqual([COORDINATOR_COMPOSITION, PROXY_OWNER].sort());

    const coordinatorCompositionCalls = callsNamed(parse(COORDINATOR_COMPOSITION), 'createCoordinatorCore');
    expect(coordinatorCompositionCalls.some((call) => objectArgumentHasProperty(call, 'providerHostAdmission'))).toBe(
      true,
    );

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
    expect(admission).toContain('matchingCandidate(data.state, slot, ref, fact.generation)');
    expect(admission).toContain('exactHostRefsMatch(placement.ref, ref)');
    expect(admission).toContain('current.generation === generation && exactHostRefsMatch(current.ref, ref)');
  });
});
