import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const BACKEND_STORE_RESET_PATH = 'src/store/backend-store-reset.ts';
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
    const coordinationBody = acquireLease.body?.getText(coordinationSource) ?? '';
    const completeIndex = coordinationBody.indexOf('coordination.completeReadiness(');
    const releaseReadinessIndex = coordinationBody.indexOf('readiness.release()');
    const writerLeaseIndex = coordinationBody.indexOf('coordination.acquireWriterLease(');

    expect(completeIndex).toBeGreaterThanOrEqual(0);
    expect(releaseReadinessIndex).toBeGreaterThan(completeIndex);
    expect(writerLeaseIndex).toBeGreaterThan(releaseReadinessIndex);

    const installSource = sourceFile(EXPANSION_INSTALL_PATH);
    const coordinatedMutation = findFunction(EXPANSION_INSTALL_PATH, 'runGenerationCoordinatedMutation');
    const coordinatedBody = coordinatedMutation.body?.getText(installSource) ?? '';
    expect(coordinatedBody.indexOf('acquirePackageOperationLock(')).toBeGreaterThan(
      coordinatedBody.indexOf('acquireGenerationWriterLeaseAfterReadiness('),
    );

    for (const functionName of ['installExpansion', 'uninstallExpansion']) {
      const mutation = findFunction(EXPANSION_INSTALL_PATH, functionName);
      const body = mutation.body?.getText(installSource) ?? '';
      expect(body.indexOf('runGenerationCoordinatedMutation(')).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps startup reset calls behind validated authority and the canonical reset lease', () => {
    const source = sourceFile(BACKEND_STORE_RESET_PATH);
    const resetFunction = findFunction(BACKEND_STORE_RESET_PATH, 'openOrResetBackendStoreDb');
    const authorityParam = resetFunction.parameters[1];
    const body = resetFunction.body?.getText(source) ?? '';
    const authorityIndex = body.indexOf('assertResetAuthority(');
    const lockPathIndex = body.indexOf("join(files.dbDir, 'store.db.reset.lock')");
    const lockIndex = body.indexOf('acquireDirectoryLockSync(');
    const resumeIndex = body.indexOf('resumeAutomaticInterruptedIncident(');
    const classificationIndex = body.indexOf('classifyStoreFile(');
    const publishIndex = body.indexOf('publishIncident(');
    const openIndex = body.indexOf('openStoreDatabase(');
    const releaseIndex = body.indexOf('releaseLock?.()');
    const directStoreUnlinks = allSourcePaths()
      .flatMap((relativePath) =>
        collectCalls(relativePath)
          .filter((call) => call.callee === 'rmSync' || call.callee === 'unlinkSync')
          .filter((call) => /store\.db|walFile|shmFile|coral\.store/.test(call.text))
          .map((call) => `${call.relativePath}:${call.line} ${call.text}`),
      )
      .sort();

    expect(authorityParam?.name.getText(sourceFile(BACKEND_STORE_RESET_PATH))).toBe('authority');
    expect(authorityParam?.type?.getText(sourceFile(BACKEND_STORE_RESET_PATH))).toBe('BackendStoreResetAuthority');
    expect(authorityIndex).toBeGreaterThanOrEqual(0);
    expect(lockPathIndex).toBeGreaterThan(authorityIndex);
    expect(lockIndex).toBeGreaterThan(lockPathIndex);
    expect(resumeIndex).toBeGreaterThan(lockIndex);
    expect(classificationIndex).toBeGreaterThan(resumeIndex);
    expect(publishIndex).toBeGreaterThan(classificationIndex);
    expect(openIndex).toBeGreaterThan(publishIndex);
    expect(releaseIndex).toBeGreaterThan(openIndex);
    expect(body).not.toMatch(/publishBackendStoreResetIncident\(|resumeInterruptedBackendStoreResetIncident\(/u);
    expect(directStoreUnlinks).toEqual([]);
  });

  it('limits startup reset reachability to V3 resume and the two core policy causes', () => {
    const source = sourceFile(BACKEND_STORE_RESET_PATH);
    const resetFunction = findFunction(BACKEND_STORE_RESET_PATH, 'openOrResetBackendStoreDb');
    const body = resetFunction.body;
    expect(body).toBeDefined();
    const bodyText = body?.getText(source) ?? '';
    const lockIndex = bodyText.indexOf('acquireDirectoryLockSync(');
    const interruptedIndex = bodyText.indexOf('resumeAutomaticInterruptedIncident(');
    const classificationIndex = bodyText.indexOf('classifyStoreFile(');

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(interruptedIndex).toBeGreaterThan(lockIndex);
    expect(classificationIndex).toBeGreaterThan(interruptedIndex);
    expect(bodyText).toContain("classification.kind === 'older-incompatible'");
    expect(bodyText).toContain("classification.kind === 'corrupt-or-unsupported'");
    expect(bodyText).not.toContain("classification.kind === 'newer-incompatible-invalid-target'");
    expect(bodyText).not.toMatch(/resumeInterruptedIncident\(/u);
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

  it('keeps backend reset access limited to lifecycle opening and the explicit operator service', () => {
    const importers = allSourcePaths()
      .filter((path) => sourceImports(path).includes(BACKEND_STORE_RESET_PATH))
      .sort();
    // V2.4 names startup-store-routing as the lifecycle seam that owns selection resolution, transition
    // recovery, and the adoption-lock scope; it is a deliberate reset owner, not leaked backend access.
    expect(importers).toEqual([
      'src/coordinator/lifecycle.ts',
      'src/store/operator-store-reset.ts',
      STARTUP_STORE_ROUTING_PATH,
    ]);

    const symbolAllowlist = new Set([
      BACKEND_STORE_RESET_PATH,
      'src/coordinator/lifecycle.ts',
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
    const backendSource = sourceFile(BACKEND_STORE_RESET_PATH);
    const topLevel = findFunction(operatorPath, 'discardStoreReset').body?.getText(operatorSource) ?? '';
    const generated = findFunction(operatorPath, 'discardGeneratedStore').body?.getText(operatorSource) ?? '';
    const recovery =
      findFunction(BACKEND_STORE_RESET_PATH, 'recoverActiveStoreTransition').body?.getText(backendSource) ?? '';
    const targetPathsIndex = topLevel.indexOf('resolveStoreResetTargetPaths(');
    const socketIndex = topLevel.indexOf('options.acquireSocketGuard(');
    const legacyRefusalIndex = topLevel.indexOf("options.target === 'legacy'");
    const generatedIndex = topLevel.indexOf('discardGeneratedStore(');
    const selectionIndex = generated.indexOf('coordinateActiveStoreSelection(');
    const maintenanceIndex = generated.indexOf('acquireGenerationMaintenanceLease(');
    const preparedOpenIndex = generated.indexOf('openOrResetBackendStoreDb(');
    const handoffIndex = generated.indexOf("selectionResult.kind === 'handoff'");
    const resetLockIndex = recovery.indexOf('acquireBackendStoreResetLock(');
    const resumeIndex = recovery.indexOf('resumeInterruptedIncident(');
    const classificationIndex = recovery.indexOf('classifyStoreForProtocol(');
    const authorizationIndex = recovery.indexOf('authorizeClassifiedStore(');
    const openIndex = recovery.indexOf('openPreparedStore');

    expect(legacyRefusalIndex).toBeGreaterThanOrEqual(0);
    expect(targetPathsIndex).toBeGreaterThan(legacyRefusalIndex);
    expect(socketIndex).toBeGreaterThan(targetPathsIndex);
    expect(generatedIndex).toBeGreaterThan(socketIndex);
    expect(selectionIndex).toBeGreaterThanOrEqual(0);
    expect(maintenanceIndex).toBeGreaterThan(selectionIndex);
    expect(preparedOpenIndex).toBeGreaterThan(maintenanceIndex);
    expect(handoffIndex).toBeGreaterThan(preparedOpenIndex);
    expect(resetLockIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeGreaterThan(resetLockIndex);
    expect(classificationIndex).toBeGreaterThan(resumeIndex);
    expect(authorizationIndex).toBeGreaterThan(classificationIndex);
    expect(openIndex).toBeGreaterThan(authorizationIndex);
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
  });
});
