import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { DOCUMENTED_CORAL_SETUP_ERROR_CODES, documentedCoralSetupError } from '#src/runtime/errors.js';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const BACKEND_STORE_RESET_PATH = 'src/store/backend-store-reset.ts';
const RESET_ACTIVE_EVIDENCE_PATH = 'src/store/reset-active-evidence.ts';
const ACTIVE_STORE_SELECTION_PATH = 'src/store/active-store-selection.ts';
const ACTIVE_STORE_SELECTION_COORDINATION_PATH = 'src/store/active-store-selection-coordination.ts';
const STARTUP_STORE_ROUTING_PATH = 'src/store/startup-store-routing.ts';
const READ_PORT_PATH = 'src/store/read-port.ts';
const KB_QUERY_RUNTIME_PATH = 'src/read-model/kb-query-runtime.ts';
const GENERATION_MUTATION_COORDINATION_PATH = 'src/store/generation-mutation-coordination.ts';
const EXPANSION_INSTALL_PATH = 'src/cli/expansion/install.ts';

type CallHit = {
  relativePath: string;
  line: number;
  callee: string;
  enclosingFunctions: readonly string[];
  text: string;
};

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split('\\').join('/');
}

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

const sourceFileCache = new Map<string, ts.SourceFile>();

function sourceFile(relativePath: string): ts.SourceFile {
  const cached = sourceFileCache.get(relativePath);
  if (cached !== undefined) return cached;
  const absolutePath = join(REPO_ROOT, relativePath);
  const parsed = ts.createSourceFile(absolutePath, readFileSync(absolutePath, 'utf8'), ts.ScriptTarget.Latest, true);
  sourceFileCache.set(relativePath, parsed);
  return parsed;
}

/**
 * Blanks every comment in `text`, leaving string/template literal content
 * untouched. The ordering assertions below match a function body's text for
 * a specific call or comparison; a commented-out call satisfies a plain
 * `.indexOf(...)` just as well as a live one, so a disabled authority, lock,
 * or resume check would read as present and correctly ordered. Blanking
 * literals too (as tests/helpers/ts-code-text.ts's `codeTextOnly` does, for
 * identifier scanning) would erase the quoted comparison values several
 * assertions below search for (e.g. `=== 'older-incompatible'`), so this
 * strips comments only. Comment ranges come from the TypeScript scanner in
 * trivia mode, not a hand-rolled quote-matching regex, for the same reason
 * ts-code-text.ts avoids one: a regex stripper cannot pair quotes correctly.
 */
function withoutComments(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
  scanner.setText(text);
  let blanked = '';
  let cursor = 0;
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      blanked += text.slice(cursor, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
      cursor = end;
    }
    token = scanner.scan();
  }
  return blanked + text.slice(cursor);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    return propertyNameText(node.name);
  }
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : null;
  }
  return null;
}

function enclosingFunctionNames(node: ts.Node): string[] {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    const name = functionName(current);
    if (name !== null) {
      names.push(name);
    }
    current = current.parent;
  }
  return names;
}

function collectCalls(relativePath: string): CallHit[] {
  const source = sourceFile(relativePath);
  const hits: CallHit[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee !== null) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        hits.push({
          relativePath,
          line: position.line + 1,
          callee,
          enclosingFunctions: enclosingFunctionNames(node),
          text: node.getText(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return hits;
}

function findFunction(relativePath: string, name: string): ts.FunctionDeclaration {
  const source = sourceFile(relativePath);
  let match: ts.FunctionDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (match === null) {
    throw new Error(`Missing function ${name} in ${relativePath}`);
  }
  return match;
}

let allSourcePathsCache: string[] | null = null;
let allSourcePathSetCache: Set<string> | null = null;

function allSourcePaths(): string[] {
  allSourcePathsCache ??= listSourceFiles(SRC_ROOT).map(toRepoPath);
  return allSourcePathsCache;
}

function allSourcePathSet(): Set<string> {
  allSourcePathSetCache ??= new Set(allSourcePaths());
  return allSourcePathSetCache;
}

function resolveSourceImport(from: string, specifier: string): string | null {
  let candidate: string;
  if (specifier.startsWith('#src/')) {
    candidate = join(REPO_ROOT, 'src', specifier.slice('#src/'.length));
  } else if (specifier.startsWith('.')) {
    candidate = resolve(REPO_ROOT, dirname(from), specifier);
  } else {
    return null;
  }
  const normalized = normalize(candidate).replace(/\.js$/u, '.ts').replaceAll('\\', '/');
  const repoPath = toRepoPath(normalized);
  const sourcePaths = allSourcePathSet();
  if (repoPath.startsWith('src/') && sourcePaths.has(repoPath)) return repoPath;
  const indexPath = repoPath.replace(/\/?$/u, '/index.ts');
  return sourcePaths.has(indexPath) ? indexPath : null;
}

function sourceImports(relativePath: string): string[] {
  const source = sourceFile(relativePath);
  return source.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
    const resolved = resolveSourceImport(relativePath, specifier);
    return resolved === null ? [] : [resolved];
  });
}

function importClosure(roots: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || visited.has(next)) continue;
    visited.add(next);
    pending.push(...sourceImports(next));
  }
  return visited;
}

function sourceWithOverrides(relativePath: string, overrides: ReadonlyMap<string, string>): ts.SourceFile {
  const override = overrides.get(relativePath);
  return override === undefined
    ? sourceFile(relativePath)
    : ts.createSourceFile(relativePath, override, ts.ScriptTarget.Latest, true);
}

function settlementStoreImportClosure(overrides: ReadonlyMap<string, string> = new Map()): string[] {
  const closure: string[] = [];
  const pending = [ACTIVE_STORE_SELECTION_COORDINATION_PATH];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || visited.has(next)) continue;
    visited.add(next);
    closure.push(next);
    const source = sourceWithOverrides(next, overrides);
    for (const statement of source.statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const imported = resolveSourceImport(next, statement.moduleSpecifier.text);
      if (imported?.startsWith('src/store/')) pending.push(imported);
    }
  }
  return closure.sort();
}

function isUnmappedErrnoRethrow(statement: ts.ThrowStatement): boolean {
  if (!ts.isIdentifier(statement.expression)) return false;
  let current: ts.Node | undefined = statement.parent;
  while (current !== undefined && !ts.isCatchClause(current)) current = current.parent;
  if (current === undefined || !ts.isCatchClause(current) || current.variableDeclaration === undefined) return false;
  return (
    ts.isIdentifier(current.variableDeclaration.name) &&
    current.variableDeclaration.name.text === statement.expression.text
  );
}

function settlementSharedNameThrowViolations(overrides: ReadonlyMap<string, string> = new Map()): readonly string[] {
  const violations: string[] = [];
  for (const relativePath of settlementStoreImportClosure(overrides)) {
    const source = sourceWithOverrides(relativePath, overrides);
    const visit = (node: ts.Node): void => {
      if (ts.isThrowStatement(node) && !isUnmappedErrnoRethrow(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        violations.push(
          `${relativePath}:${line} ${enclosingFunctionNames(node)[0] ?? '<module>'}: ${node.getText(source)}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations.sort();
}

function settlementSemanticRefusalCount(overrides: ReadonlyMap<string, string> = new Map()): number {
  return settlementSharedNameThrowViolations(overrides).length;
}

function injectedSettlementThrow(): ReadonlyMap<string, string> {
  const source = readFileSync(join(REPO_ROOT, BACKEND_STORE_RESET_PATH), 'utf8');
  const needle = 'const pathBefore = stablePathStat(storage, candidate.source);';
  expect(source).toContain(needle);
  return new Map([
    [
      BACKEND_STORE_RESET_PATH,
      source.replace(needle, `${needle}\n  throw new Error('injected imported-module failure');`),
    ],
  ]);
}

describe('store reset discipline invariants', () => {
  // Note: these invariants check direct call sites within the named function
  // body - transitive calls (helper-of-helper invoking a forbidden symbol)
  // are not flagged. The import-list check provides a coarser net catching
  // module-level introduction of the forbidden symbols.
  it('keeps the read-only opener free of schema execution, reset authority, and store-file quarantine', () => {
    const source = sourceFile(READ_PORT_PATH);
    const calls = collectCalls(READ_PORT_PATH).filter((call) =>
      call.enclosingFunctions.includes('openReadOnlyStoreDatabase'),
    );
    const forbiddenCalls = calls
      .filter((call) =>
        [
          'applyBundledStoreSchema',
          'openOrResetBackendStoreDb',
          'createBackendStoreResetAuthority',
          'quarantineStoreFiles',
          'rmSync',
          'unlinkSync',
        ].includes(call.callee),
      )
      .map((call) => `${call.relativePath}:${call.line} ${call.text}`);
    const forbiddenImports = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.getText(source))
      .filter((text) =>
        /openOrResetBackendStoreDb|createBackendStoreResetAuthority|quarantineStoreFiles|applyBundledStoreSchema/.test(
          text,
        ),
      );

    expect(forbiddenImports).toEqual([]);
    expect(forbiddenCalls).toEqual([]);
  });

  it('keeps read-only store and KB-query construction non-creating and non-reconciling', () => {
    const readPortSource = readFileSync(join(REPO_ROOT, READ_PORT_PATH), 'utf8');
    const queryRuntimeSource = readFileSync(join(REPO_ROOT, KB_QUERY_RUNTIME_PATH), 'utf8');

    expect(readPortSource).not.toMatch(/mkdirSync/u);
    expect(queryRuntimeSource).not.toMatch(
      /\bcreateKbRuntime\b|KbRuntimeImpl|mkdirSync|adoptStagedSurfaceHashes|reconcileCorpusProjectionCommits/u,
    );
  });

  it('orders expansion mutations after readiness release and writer-lease acquisition', () => {
    const coordinationSource = sourceFile(GENERATION_MUTATION_COORDINATION_PATH);
    const acquireLease = findFunction(
      GENERATION_MUTATION_COORDINATION_PATH,
      'acquireGenerationWriterLeaseAfterReadiness',
    );
    const coordinationBody = withoutComments(acquireLease.body?.getText(coordinationSource) ?? '');
    const completeIndex = coordinationBody.indexOf('coordination.completeReadiness(');
    const releaseReadinessIndex = coordinationBody.indexOf('readiness.release()');
    const writerLeaseIndex = coordinationBody.indexOf('coordination.acquireWriterLease(');

    expect(completeIndex).toBeGreaterThanOrEqual(0);
    expect(releaseReadinessIndex).toBeGreaterThan(completeIndex);
    expect(writerLeaseIndex).toBeGreaterThan(releaseReadinessIndex);

    const installSource = sourceFile(EXPANSION_INSTALL_PATH);
    const coordinatedMutation = findFunction(EXPANSION_INSTALL_PATH, 'runGenerationCoordinatedMutation');
    const coordinatedBody = withoutComments(coordinatedMutation.body?.getText(installSource) ?? '');
    expect(coordinatedBody.indexOf('acquirePackageOperationLock(')).toBeGreaterThan(
      coordinatedBody.indexOf('acquireGenerationWriterLeaseAfterReadiness('),
    );

    for (const functionName of ['installExpansion', 'uninstallExpansion']) {
      const mutation = findFunction(EXPANSION_INSTALL_PATH, functionName);
      const body = withoutComments(mutation.body?.getText(installSource) ?? '');
      expect(body.indexOf('runGenerationCoordinatedMutation(')).toBeGreaterThanOrEqual(0);
    }
  });

  it('classifies under exclusion and publishes once before the unbounded owned-store claim loop', () => {
    const coordination = sourceFile(ACTIVE_STORE_SELECTION_COORDINATION_PATH);
    const settlement = findFunction(ACTIVE_STORE_SELECTION_COORDINATION_PATH, 'settleActiveStore');
    const body = withoutComments(settlement.body?.getText(coordination) ?? '');
    const observeIndex = body.indexOf('runtime.storage.existsSync(dbFile)');
    const acquireExclusionIndex = body.indexOf('acquireSettlementWriterExclusion(');
    const resetLockIndex = body.indexOf('acquireBackendStoreResetLock(');
    const resumeIndex = body.indexOf('resumeBackendStoreResetIncident');
    const loopIndex = body.indexOf('for (;;)');
    const publishIndex = body.indexOf('publishClassifiedBackendStoreResetIncident(');
    const stageIndex = body.indexOf('mintActiveStoreEpoch(');
    const mintIndex = body.indexOf('mintBackendStoreForClaim(');

    expect(observeIndex).toBeGreaterThanOrEqual(0);
    expect(acquireExclusionIndex).toBeGreaterThan(observeIndex);
    expect(stageIndex).toBeGreaterThan(acquireExclusionIndex);
    expect(resetLockIndex).toBeGreaterThan(stageIndex);
    expect(resumeIndex).toBeGreaterThan(resetLockIndex);
    expect(publishIndex).toBeGreaterThan(resumeIndex);
    expect(mintIndex).toBeGreaterThan(publishIndex);
    expect(loopIndex).toBeGreaterThan(publishIndex);
    expect(body).not.toContain('openWritableStoreDatabase(');
    expect(body).not.toContain('classifyStoreForProtocol(');
    expect(body).not.toContain('publications.length === 2');

    const publicationCalls = allSourcePaths().flatMap((path) =>
      collectCalls(path).filter((call) => call.callee === 'publishClassifiedBackendStoreResetIncident'),
    );
    expect(publicationCalls).toHaveLength(1);
    expect(publicationCalls[0]?.relativePath).toBe(ACTIVE_STORE_SELECTION_COORDINATION_PATH);
    expect(publicationCalls[0]?.enclosingFunctions).toContain('settleActiveStore');

    const openCalls = settlementStoreImportClosure()
      .flatMap(collectCalls)
      .filter((call) => call.relativePath === BACKEND_STORE_RESET_PATH)
      .filter((call) => call.callee === 'openWritableStoreDatabase');
    expect(openCalls.map((call) => [call.relativePath, call.enclosingFunctions[0]])).toEqual([
      [BACKEND_STORE_RESET_PATH, 'mintBackendStoreForClaim'],
      [BACKEND_STORE_RESET_PATH, 'cloneParkedStoreForClaim'],
      [BACKEND_STORE_RESET_PATH, 'openCompatibleParkedStore'],
    ]);
    expect(openCalls.every((call) => !/files\.dbFile|activeEvidencePath/u.test(call.text))).toBe(true);

    const source = allSourcePaths()
      .map((path) => readFileSync(join(REPO_ROOT, path), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(
      /\b(?:openOrResetBackendStoreDb|authorizeClassifiedStore|openProtocolStore|openPreparedStore|recordRecoveryOutcome|recordInvalidTargetRecovery)\b/u,
    );
  });

  it('has at most 131 semantic refusals in the settlement closure (target: 0)', () => {
    const overrides = process.env.CORAL_TEST_INJECT_SETTLEMENT_THROW === '1' ? injectedSettlementThrow() : new Map();
    expect(settlementSemanticRefusalCount(overrides)).toBeLessThanOrEqual(131);
  });

  it('detects a semantic throw injected into an imported settlement module the old closure missed', () => {
    const baseline = settlementSharedNameThrowViolations();
    const violations = settlementSharedNameThrowViolations(injectedSettlementThrow());
    expect(violations).toContainEqual(
      expect.stringContaining("describeCandidate: throw new Error('injected imported-module failure')"),
    );
    expect(violations).toHaveLength(baseline.length + 1);
  });

  it('maps expected maintenance-acquisition failures to copy dispositions', () => {
    const source = sourceFile(BACKEND_STORE_RESET_PATH);
    const acquire = findFunction(BACKEND_STORE_RESET_PATH, 'acquireBackendStoreWriterExclusion');
    const tryStatement = acquire.body?.statements.find(ts.isTryStatement);
    const catchStatements = tryStatement?.catchClause?.block.statements;
    expect(catchStatements).toHaveLength(4);

    const expected = [
      ["error instanceof CoralSetupError && error.code === 'legacy_source_not_quiescent'", 'writer-live'],
      [
        "error instanceof CoralSetupError && error.code === 'legacy_source_writer_observation_unknown'",
        'writer-unobservable',
      ],
      ['isDirectoryLockTimeoutError(error)', 'lock-timeout'],
    ] as const;
    for (const [index, [condition, reason]] of expected.entries()) {
      const statement = catchStatements?.[index];
      expect(statement).toBeDefined();
      if (statement === undefined) continue;
      expect(ts.isIfStatement(statement)).toBe(true);
      if (!ts.isIfStatement(statement)) continue;
      expect(statement.expression.getText(source)).toBe(condition);
      expect(statement.elseStatement).toBeUndefined();
      expect(ts.isBlock(statement.thenStatement)).toBe(true);
      if (!ts.isBlock(statement.thenStatement)) continue;
      expect(statement.thenStatement.statements).toHaveLength(1);
      const returned = statement.thenStatement.statements[0];
      expect(ts.isReturnStatement(returned)).toBe(true);
      if (!ts.isReturnStatement(returned) || returned.expression === undefined) continue;
      expect(ts.isObjectLiteralExpression(returned.expression)).toBe(true);
      if (!ts.isObjectLiteralExpression(returned.expression)) continue;
      const reasonProperty = returned.expression.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'reason',
      );
      expect(reasonProperty?.initializer.getText(source)).toBe(`'${reason}'`);
    }

    const finalStatement = catchStatements?.[3];
    expect(finalStatement).toBeDefined();
    if (finalStatement !== undefined) expect(ts.isThrowStatement(finalStatement)).toBe(true);
    if (finalStatement !== undefined && ts.isThrowStatement(finalStatement)) {
      expect(finalStatement.expression.getText(source)).toBe('error');
    }
  });

  it('parks active evidence before publishing the manifest', () => {
    const calls = collectCalls(RESET_ACTIVE_EVIDENCE_PATH);
    const linkCalls = calls.filter((call) => call.callee === 'linkSync');
    const incidentSource = sourceFile(BACKEND_STORE_RESET_PATH);
    const publish = withoutComments(
      findFunction(BACKEND_STORE_RESET_PATH, 'publishIncident').body?.getText(incidentSource) ?? '',
    );

    expect(linkCalls).toHaveLength(2);
    expect(linkCalls.map((call) => call.enclosingFunctions[0]).sort()).toEqual([
      'linkOwnedEvidenceToActive',
      'restoreParkedEvidence',
    ]);
    const stageIndex = publish.indexOf('copyIncidentEvidence(');
    const parkIndex = publish.indexOf('parkIncidentEvidence(');
    const manifestIndex = publish.indexOf('createIncidentManifest(');
    expect(stageIndex).toBeGreaterThanOrEqual(0);
    expect(parkIndex).toBeGreaterThan(stageIndex);
    expect(manifestIndex).toBeGreaterThan(parkIndex);
  });

  it('commits every terminal parking survivor through one sidecar-rename-rotation transition', () => {
    const source = sourceFile(BACKEND_STORE_RESET_PATH);
    const transition = withoutComments(
      findFunction(BACKEND_STORE_RESET_PATH, 'commitTerminalParking').body?.getText(source) ?? '',
    );
    expect(transition.indexOf('writeStoreResetParkedRecord(')).toBeLessThan(transition.indexOf('populate();'));
    expect(transition.indexOf('populate();')).toBeLessThan(transition.indexOf('renameSync('));
    expect(transition.indexOf('renameSync(')).toBeLessThan(transition.indexOf('recordStoreResetParked('));

    for (const [functionName, transitionCall] of [
      ['terminalizeParking', 'commitTerminalParking('],
      ['retainInterruptedMintedStores', 'commitTerminalParking('],
      ['retireNonResumableFixedParking', 'terminalizeParking('],
      ['retainNonRegularParking', 'commitTerminalParking('],
    ] as const) {
      const body = withoutComments(findFunction(BACKEND_STORE_RESET_PATH, functionName).body?.getText(source) ?? '');
      expect(body, functionName).toContain(transitionCall);
    }

    const retentionCommitters = settlementStoreImportClosure()
      .flatMap(collectCalls)
      .filter((call) => call.callee === 'recordStoreResetParked')
      .map((call) => call.enclosingFunctions[0]);
    expect(retentionCommitters).toEqual(['commitTerminalParking']);
  });

  it('keeps shared-path capabilities and exact inode identity inside their canonical owner', () => {
    const forbiddenProperties = new Set(['dbFile', 'walFile', 'shmFile', 'formatFile']);
    const externalPathAccesses: string[] = [];
    for (const relativePath of allSourcePaths()) {
      if (relativePath === RESET_ACTIVE_EVIDENCE_PATH) continue;
      const source = sourceFile(relativePath);
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && forbiddenProperties.has(node.name.text)) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          externalPathAccesses.push(`${relativePath}:${position.line + 1} ${node.getText(source)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    const owner = sourceFile(RESET_ACTIVE_EVIDENCE_PATH);
    const activeEvidenceIdentity = owner.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ActiveEvidenceIdentity',
    );
    expect(activeEvidenceIdentity).toBeDefined();
    const identityType =
      activeEvidenceIdentity !== undefined &&
      ts.isTypeReferenceNode(activeEvidenceIdentity.type) &&
      activeEvidenceIdentity.type.typeName.getText(owner) === 'Readonly'
        ? activeEvidenceIdentity.type.typeArguments?.[0]
        : activeEvidenceIdentity?.type;
    const identityProperties =
      identityType !== undefined && ts.isTypeLiteralNode(identityType)
        ? identityType.members.flatMap((member) =>
            ts.isPropertySignature(member) && member.name !== undefined ? [propertyNameText(member.name)] : [],
          )
        : [];
    expect(identityProperties).toEqual(['dev', 'ino']);

    const activeEvidenceSource = readFileSync(join(REPO_ROOT, RESET_ACTIVE_EVIDENCE_PATH), 'utf8');
    expect(activeEvidenceSource).not.toMatch(
      /\b(?:reobserve|ActiveEvidenceExpectation|hashActiveContent|sameEvidenceIdentity|removeActiveEvidence)\b/u,
    );

    const candidate = owner.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'candidateForEvidence',
    );
    expect(candidate).toBeDefined();
    expect(candidate?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(
      false,
    );

    const unlinkCalls = collectCalls(RESET_ACTIVE_EVIDENCE_PATH).filter((call) => call.callee === 'unlinkSync');
    expect(unlinkCalls.map((call) => call.enclosingFunctions[0]).sort()).toEqual([
      'dropParkedEvidence',
      'restoreParkedEvidence',
    ]);
    expect(unlinkCalls.every((call) => call.text.includes('parkedPath(parkingDirectory, parked.evidence)'))).toBe(true);

    const sharedPathCalls = collectCalls(RESET_ACTIVE_EVIDENCE_PATH).filter(
      (call) => call.callee !== 'candidateForEvidence' && call.text.includes('candidateForEvidence('),
    );
    expect(sharedPathCalls.map((call) => call.callee).sort()).toEqual([
      'linkSync',
      'linkSync',
      'lstatSync',
      'openSync',
      'renameSync',
      'renameSync',
    ]);
    expect(externalPathAccesses).toEqual([]);
  });

  it('keeps destructive release out of store-reset remediation text', () => {
    for (const code of DOCUMENTED_CORAL_SETUP_ERROR_CODES.filter((candidate) => candidate.startsWith('store_reset_'))) {
      const remediation = documentedCoralSetupError({ code }).remediation;
      expect(remediation, code).not.toContain('store-reset release');
    }
  });

  it('keeps the complete store classification union in the settlement loop', () => {
    const source = sourceFile(ACTIVE_STORE_SELECTION_COORDINATION_PATH);
    const settlement = withoutComments(
      findFunction(ACTIVE_STORE_SELECTION_COORDINATION_PATH, 'settleActiveStore').body?.getText(source) ?? '',
    );

    for (const kind of [
      'absent',
      'fresh',
      'compatible',
      'legacy-adoptable',
      'older-incompatible',
      'newer-incompatible',
      'corrupt-or-unsupported',
    ]) {
      expect(settlement).toContain(`case '${kind}'`);
    }
    expect(settlement).toContain('default:');
    expect(settlement).toContain('assertNever(activeEpoch.classification)');
    expect(settlement).toContain('resumeAutomaticBackendStoreResetIncident(');
    expect(settlement).toContain('resumeBackendStoreResetIncidentForOperator(');
    expect(settlement).toContain("survivor = { kind: 'incident', incident: publication.incident, resumed: false }");
    expect(settlement).toContain('survivor: finalStoreResetSurvivor(runtime, files, survivor)');
  });

  it('keeps every store-reset support import closure outside reset authority and generic DB openers', () => {
    const supportRoots = [
      'src/cli/format/store-reset.ts',
      'src/store/reset-incident-reader.ts',
      'src/store/reset-incident-diagnostic.ts',
      'src/store/reset-incident-inspection-fs.ts',
      'src/infra/store-reset-inspection-fs.ts',
      'src/infra/store-reset-diagnostic-supervisor.ts',
    ];
    const supportClosure = importClosure(supportRoots);
    expect(supportClosure.has(BACKEND_STORE_RESET_PATH)).toBe(false);
    expect(supportClosure.has('src/store/db.ts')).toBe(false);
  });

  it('keeps active-store records and the locked coordination protocol in their canonical modules', () => {
    const records = readFileSync(join(REPO_ROOT, ACTIVE_STORE_SELECTION_PATH), 'utf8');
    const coordination = readFileSync(join(REPO_ROOT, ACTIVE_STORE_SELECTION_COORDINATION_PATH), 'utf8');
    const backendReset = readFileSync(join(REPO_ROOT, BACKEND_STORE_RESET_PATH), 'utf8');
    const startupRouting = readFileSync(join(REPO_ROOT, STARTUP_STORE_ROUTING_PATH), 'utf8');

    expect(records).toContain('export function publishActiveStoreSelection(');
    expect(records).toContain('export function publishActiveStoreTransition(');
    expect(records).toContain('export function clearActiveStoreTransition(');
    expect(coordination).toContain('export async function coordinateActiveStoreSelection(');
    expect(backendReset).not.toMatch(/ActiveStore|publishActiveStore|clearActiveStore/u);
    expect(startupRouting).not.toContain('routeActiveStoreSelection');
  });

  it('keeps backend reset access limited to lifecycle opening and the explicit operator service', () => {
    const importers = allSourcePaths()
      .filter((path) => sourceImports(path).includes(BACKEND_STORE_RESET_PATH))
      .sort();
    const coordinationImporters = allSourcePaths()
      .filter((path) => sourceImports(path).includes(ACTIVE_STORE_SELECTION_COORDINATION_PATH))
      .sort();
    // Startup-store routing owns selection resolution, transition recovery, and the adoption-lock scope; it
    // is a deliberate reset owner, not leaked backend access.
    expect(importers).toEqual([
      'src/coordinator/lifecycle.ts',
      ACTIVE_STORE_SELECTION_COORDINATION_PATH,
      'src/store/operator-store-reset.ts',
      STARTUP_STORE_ROUTING_PATH,
    ]);
    expect(coordinationImporters).toEqual(['src/store/operator-store-reset.ts', STARTUP_STORE_ROUTING_PATH]);

    const symbolAllowlist = new Set([
      BACKEND_STORE_RESET_PATH,
      'src/coordinator/lifecycle.ts',
      ACTIVE_STORE_SELECTION_COORDINATION_PATH,
      'src/store/operator-store-reset.ts',
      STARTUP_STORE_ROUTING_PATH,
    ]);
    const forbiddenReferences = allSourcePaths()
      .filter((path) => !symbolAllowlist.has(path))
      .flatMap((path) => {
        const source = readFileSync(join(REPO_ROOT, path), 'utf8');
        return /createBackendStoreResetAuthority|openOrResetBackendStoreDb|publishIncident/u.test(source) ? [path] : [];
      });
    expect(forbiddenReferences).toEqual([]);
  });

  it('keeps operator reset composition behind the socket guard and shared selection coordinator', () => {
    const operatorPath = 'src/store/operator-store-reset.ts';
    const operatorSource = sourceFile(operatorPath);
    const topLevel = withoutComments(
      findFunction(operatorPath, 'discardStoreReset').body?.getText(operatorSource) ?? '',
    );
    const generated = withoutComments(
      findFunction(operatorPath, 'discardGeneratedStore').body?.getText(operatorSource) ?? '',
    );
    const targetPathsIndex = topLevel.indexOf('resolveStoreResetTargetPaths(');
    const socketIndex = topLevel.indexOf('options.acquireSocketGuard(');
    const legacyRefusalIndex = topLevel.indexOf("options.target === 'legacy'");
    const generatedIndex = topLevel.indexOf('discardGeneratedStore(');
    const selectionIndex = generated.indexOf('coordinateActiveStoreSelection(');
    const handoffIndex = generated.indexOf("selectionResult.kind === 'handoff'");

    expect(legacyRefusalIndex).toBeGreaterThanOrEqual(0);
    expect(targetPathsIndex).toBeGreaterThan(legacyRefusalIndex);
    expect(socketIndex).toBeGreaterThan(targetPathsIndex);
    expect(generatedIndex).toBeGreaterThan(socketIndex);
    expect(selectionIndex).toBeGreaterThanOrEqual(0);
    expect(handoffIndex).toBeGreaterThan(selectionIndex);
    expect(generated).not.toMatch(
      /acquireGenerationAdoptionLease|acquireStoreResetLock|resumeInterruptedBackendStoreResetIncident|publishBackendStoreResetIncident/u,
    );
    expect(readFileSync(join(REPO_ROOT, operatorPath), 'utf8')).not.toMatch(/shutdownAndAwaitRelease/u);
    expect(readFileSync(join(REPO_ROOT, operatorPath), 'utf8')).toContain(
      'Destructive operator service used while the coordinator is deliberately',
    );
    expect(readFileSync(join(REPO_ROOT, 'src/cli/store-reset.ts'), 'utf8')).not.toContain('backend-store-reset.js');

    const destructiveCallers = allSourcePaths()
      .flatMap((path) =>
        collectCalls(path)
          .filter((call) =>
            ['publishBackendStoreResetIncident', 'resumeInterruptedBackendStoreResetIncident'].includes(call.callee),
          )
          .map((call) => call.relativePath),
      )
      .sort();
    expect(destructiveCallers).toEqual([]);
    expect(readFileSync(join(REPO_ROOT, BACKEND_STORE_RESET_PATH), 'utf8')).not.toMatch(
      /export function (?:publishBackendStoreResetIncident|resumeInterruptedBackendStoreResetIncident)\b/u,
    );
  });
});

describe('withoutComments', () => {
  it('blanks a commented-out call so an ordering assertion cannot mistake it for a live one', () => {
    // Reproduces the defect this file's ordering assertions guard against:
    // on raw getText() output, a disabled (commented-out) authority check
    // reads as present — `indexOf` finds it in the comment text just as
    // readily as it would find a live call.
    const source = [
      'function openOrResetBackendStoreDb() {',
      '  // assertBackendStoreResetAuthority(runtime, authority, options);',
      '  acquireBackendStoreResetLock(runtime, files, adoption);',
      '}',
    ].join('\n');

    expect(source.indexOf('assertBackendStoreResetAuthority(')).toBeGreaterThanOrEqual(0);

    const stripped = withoutComments(source);
    expect(stripped.indexOf('assertBackendStoreResetAuthority(')).toBe(-1);
    expect(stripped).toContain('acquireBackendStoreResetLock(');
  });

  it('preserves quoted comparison values that ordering assertions search for', () => {
    // tests/helpers/ts-code-text.ts's codeTextOnly blanks string/template
    // literals too, which would erase the comparison values the ordering
    // assertions above search for (e.g. classification.kind === 'older-
    // incompatible'); withoutComments must leave literal content intact.
    const source = "if (classification.kind === 'older-incompatible') { /* handled */ }";

    const stripped = withoutComments(source);
    expect(stripped).toContain("classification.kind === 'older-incompatible'");
    expect(stripped).not.toContain('handled');
  });
});
