import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests/invariants/fixtures/no-build-tenancy.ts.txt');
const READ_STORE_FILE = 'src/cli/read-store.ts';
const CORAL_STORE_FILE = 'src/read-model/coral-store.ts';

type Rule =
  | 'belongsToNamespace symbol'
  | 'liveJobCountByNamespace call'
  | 'countProjectedLiveJobsByNamespace call'
  | 'loadJobDetail namespace option'
  | 'JobsListFilters.namespace'
  | 'readOrderedProjectionRows namespace comparison'
  | 'CoralStore.jobs.list namespace injection'
  | 'CoralStore.jobs.detail namespace injection'
  | 'direct-read pluginRootNamespace derivation'
  | 'recovery backendNamespace comparison'
  | 'adoptOrphanedCrossNamespaceJobs symbol'
  | 'origin/current namespace comparison'
  | 'launchEventNamespace comparison'
  | 'crashedJobTerminalizationSource namespace parameter'
  | 'crashedJobTerminalizationSource namespace argument'
  | 'namespace equality SQL predicate outside allowlist'
  | 'bundleHash work-tenancy comparison'
  | 'rebindNamespace outside recovery allowlist'
  | 'namespace provenance outside allowlist';

type TypeScriptProductionSource = Readonly<{
  kind: 'typescript';
  file: string;
  sourceFile: ts.SourceFile;
  text: string;
}>;

type SqlProductionSource = Readonly<{
  kind: 'sql';
  file: string;
  text: string;
}>;

type ProductionSource = TypeScriptProductionSource | SqlProductionSource;

type MutationFixture = Readonly<{
  name: string;
  file: string;
  rule: Rule;
  source: string;
}>;

const REBIND_ALLOWLIST = new Map<string, number>([
  ['src/jobs/store.ts#JobStore.rebindNamespace', 1],
  ['src/jobs/contracts/job-store.ts#JobProgressStore.rebindNamespace', 1],
  ['src/coordinator/services/recovery/service.ts#RecoveryService.recoverQueuedJob', 1],
  ['src/coordinator/services/recovery/service.ts#RecoveryService.adoptRunningJob', 1],
]);

const STALE_ARTIFACT_ALLOWLIST = new Map<string, number>([
  ['src/jobs/stale-job-cleanup-recovery-source.ts#staleJobCleanupSource', 1],
  ['src/coordinator/startup-recovery.ts#runStartupStaleArtifactPrune', 1],
  ['src/coordinator/lifecycle.ts#createStaleJobCleanupPolicy', 1],
]);

const NAMESPACE_PROVENANCE_ALLOWLIST = new Map<string, number>([
  ['src/coordinator/composition/index.ts#recordHostedKbFailure', 1],
  ['src/coordinator/execution-service.ts#ExecutionService.runWithInvocationScope', 1],
  ['src/coordinator/lifecycle.ts#createCrashedJobTerminalizationPolicy', 1],
  ['src/coordinator/services/job-launch.ts#JobLaunchService.mintChildPrincipalSecretEnv', 1],
  ['src/coordinator/services/provider-event-application.ts#resolveJobContext', 1],
  ['src/coordinator/services/recovery/index.ts#settleCoordinatorRecoveryItem', 2],
  ['src/coordinator/services/recovery/interrupted-finalizer.ts#finalizeInterruptedAppServerRecovery', 1],
  ['src/coordinator/services/recovery/interrupted-finalizer.ts#directTerminalAppender', 1],
  ['src/coordinator/services/recovery/interrupted-finalizer.ts#finalizeInterruptedDurableRecovery', 1],
  ['src/coordinator/services/recovery/service.ts#RecoveryService.queuedRecoveryChildEnv', 1],
  ['src/coordinator/services/workflow-execution.ts#WorkflowExecutionService.executeWorkflow', 2],
  ['src/jobs/kb/recorder.ts#KbJobRecorder.appendOperationFailureWithTerminal', 2],
  ['src/jobs/reconcile/recovery-effects.ts#markJobAsError', 1],
  ['src/jobs/reconcile/recovery-effects.ts#recoveryFaultOutcome', 1],
  ['src/jobs/shell/launch.ts#LaunchOrchestrator.resolveEventMetadata', 1],
  ['src/jobs/shell/launch.ts#LaunchOrchestrator.writeJobTerminal', 1],
  ['src/jobs/store.ts#jobLaunchRequestedEvent', 1],
  ['src/jobs/store.ts#JobStore.initJob', 2],
  ['src/jobs/store.ts#JobStore.appendRuntimeStarted', 1],
  ['src/jobs/store.ts#JobStore.appendProgress', 1],
  ['src/workflow/recover.ts#finalizationRecording', 1],
]);

const NAMESPACE_SQL_PREDICATE_ALLOWLIST = new Map<string, number>();
const NAMESPACE_SQL_PREDICATE = /\b(?:backend_)?namespace\s*=\s*(?:\?|[:@$][A-Za-z_][A-Za-z0-9_]*)/u;

function listProductionSqlFiles(dirPath: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionSqlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function productionSources(): ProductionSource[] {
  const sourceRoot = resolve(REPO_ROOT, 'src');
  const typescript = listProductionSourceFiles(sourceRoot).map((filePath): TypeScriptProductionSource => {
    const file = relative(REPO_ROOT, filePath).replaceAll('\\', '/');
    const text = readFileSync(filePath, 'utf8');
    return {
      kind: 'typescript',
      file,
      text,
      sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
    };
  });
  const sql = listProductionSqlFiles(sourceRoot).map(
    (filePath): SqlProductionSource => ({
      kind: 'sql',
      file: relative(REPO_ROOT, filePath).replaceAll('\\', '/'),
      text: readFileSync(filePath, 'utf8'),
    }),
  );
  return [...typescript, ...sql].sort((left, right) => left.file.localeCompare(right.file));
}

function parseMutationFixtures(): MutationFixture[] {
  const fixtures: MutationFixture[] = [];
  const sections = readFileSync(FIXTURE_PATH, 'utf8')
    .split(/^\/\/ === /mu)
    .slice(1);
  for (const section of sections) {
    const newline = section.indexOf('\n');
    const header = section.slice(0, newline).trim().split('|');
    if (header.length !== 3) throw new Error(`Invalid no-build-tenancy fixture header: ${header.join('|')}`);
    const [name, file, rule] = header;
    fixtures.push({ name, file, rule: rule as Rule, source: section.slice(newline + 1).trim() });
  }
  return fixtures;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function accessPath(expression: ts.Expression): readonly string[] | null {
  const node = unwrapExpression(expression);
  if (ts.isIdentifier(node)) return [node.text];
  if (node.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
  if (ts.isPropertyAccessExpression(node)) {
    const owner = accessPath(node.expression);
    return owner === null ? null : [...owner, node.name.text];
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    const owner = accessPath(node.expression);
    const key = unwrapExpression(node.argumentExpression);
    return owner !== null && ts.isStringLiteralLike(key) ? [...owner, key.text] : null;
  }
  return null;
}

function pathText(expression: ts.Expression): string | null {
  return accessPath(expression)?.join('.') ?? null;
}

function containsPath(expression: ts.Expression, predicate: (path: readonly string[]) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isExpression(node)) {
      const path = accessPath(node);
      if (path !== null && predicate(path)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function callName(node: ts.CallExpression): string | null {
  const called = unwrapExpression(node.expression);
  if (ts.isIdentifier(called)) return called.text;
  if (ts.isPropertyAccessExpression(called)) return called.name.text;
  return null;
}

function isEquality(node: ts.BinaryExpression): boolean {
  return (
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function enclosingSymbol(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current)) {
      const method = propertyName(current.name) ?? '<computed>';
      const owner = current.parent;
      if ((ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) && owner.name !== undefined) {
        return `${owner.name.text}.${method}`;
      }
      continue;
    }
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer !== undefined &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return current.name.text;
    }
  }
  return '<module>';
}

function enclosingClass(node: ts.Node): string | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isClassDeclaration(current)) return current.name?.text ?? null;
  }
  return null;
}

function insideNamedSymbol(node: ts.Node, name: string): boolean {
  return enclosingSymbol(node).split('.').at(-1) === name;
}

function hasNamespaceProperty(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(current) ||
        ts.isShorthandPropertyAssignment(current) ||
        ts.isPropertySignature(current)) &&
      propertyName(current.name) === 'namespace'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function hasNamespaceReference(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'namespace') {
      found = true;
      return;
    }
    if (ts.isIdentifier(current) && ['namespace', 'currentNamespace', 'lifecycleNamespace'].includes(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isOriginBackendNamespace(expression: ts.Expression): boolean {
  const path = accessPath(expression);
  if (path === null) return false;
  const last = path.at(-1);
  if (last !== 'backendNamespace' && last !== 'backend_namespace') return false;
  if (path.length === 1) return true;
  return ['status', 'launch', 'job', 'record', 'projection', 'item', 'row', 'entry'].includes(path.at(-2) ?? '');
}

function isCurrentNamespace(expression: ts.Expression): boolean {
  const path = accessPath(expression);
  if (path === null) return false;
  const text = path.join('.');
  return (
    text === 'namespace' ||
    text === 'currentNamespace' ||
    text === 'lifecycleNamespace' ||
    text === 'world.namespace' ||
    text === 'identity.namespace' ||
    text === 'this.backendNamespace' ||
    text.endsWith('.deps.backendNamespace')
  );
}

function isOriginNamespace(expression: ts.Expression): boolean {
  const path = accessPath(expression);
  if (path === null) return false;
  const text = path.join('.');
  return (
    text === 'originNamespace' ||
    text === 'launchEventNamespace' ||
    text.endsWith('.origin.namespace') ||
    isOriginBackendNamespace(expression)
  );
}

function isScopedRecoveryFile(file: string): boolean {
  return (
    file.startsWith('src/jobs/reconcile/') ||
    file.startsWith('src/coordinator/services/recovery/') ||
    file === 'src/coordinator/composition/job-control.ts' ||
    file === 'src/coordinator/composition/index.ts'
  );
}

function isBundleTenancyComparison(node: ts.BinaryExpression): boolean {
  const left = pathText(node.left);
  const right = pathText(node.right);
  return (
    isEquality(node) &&
    ((left?.endsWith('bundleHash') === true && right?.endsWith('currentBundleHash') === true) ||
      (right?.endsWith('bundleHash') === true && left?.endsWith('currentBundleHash') === true))
  );
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
}

function scanNoBuildTenancySources(
  sources: readonly ProductionSource[],
  options: { verifyAllowlist?: boolean } = {},
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  const rebindHits = new Map<string, number>();
  const staleArtifactHits = new Map<string, number>();
  const namespaceProvenanceHits = new Map<string, number>();
  const namespaceSqlPredicateHits = new Map<string, number>();

  const addAtLine = (file: string, line: number, rule: Rule, symbol: string): void => {
    const message = `${file}:${line}: ${rule}: ${symbol}`;
    if (!seen.has(message)) {
      seen.add(message);
      violations.push(message);
    }
  };

  const add = (source: TypeScriptProductionSource, node: ts.Node, rule: Rule, symbol: string): void => {
    const line = source.sourceFile.getLineAndCharacterOfPosition(node.getStart(source.sourceFile)).line + 1;
    addAtLine(source.file, line, rule, symbol);
  };

  for (const source of sources) {
    if (source.kind === 'sql') {
      const matcher = new RegExp(NAMESPACE_SQL_PREDICATE.source, 'gu');
      for (const match of source.text.matchAll(matcher)) {
        const allowlistKey = `${source.file}#<sql>`;
        if (NAMESPACE_SQL_PREDICATE_ALLOWLIST.has(allowlistKey)) {
          namespaceSqlPredicateHits.set(allowlistKey, (namespaceSqlPredicateHits.get(allowlistKey) ?? 0) + 1);
        } else {
          const line = source.text.slice(0, match.index).split('\n').length;
          addAtLine(
            source.file,
            line,
            'namespace equality SQL predicate outside allowlist',
            `${allowlistKey}: ${match[0]}`,
          );
        }
      }
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (node.text === 'belongsToNamespace') add(source, node, 'belongsToNamespace symbol', node.text);
        if (node.text === 'adoptOrphanedCrossNamespaceJobs') {
          add(source, node, 'adoptOrphanedCrossNamespaceJobs symbol', node.text);
        }
        if (node.text === 'rebindNamespace') {
          const allowlistKey = `${source.file}#${enclosingSymbol(node)}`;
          if (REBIND_ALLOWLIST.has(allowlistKey)) {
            rebindHits.set(allowlistKey, (rebindHits.get(allowlistKey) ?? 0) + 1);
          } else {
            add(source, node, 'rebindNamespace outside recovery allowlist', node.text);
          }
        }
      }

      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === 'namespace' &&
        containsPath(node.initializer, (path) => path.at(-1) === 'backendNamespace')
      ) {
        const allowlistKey = `${source.file}#${enclosingSymbol(node)}`;
        if (NAMESPACE_PROVENANCE_ALLOWLIST.has(allowlistKey)) {
          namespaceProvenanceHits.set(allowlistKey, (namespaceProvenanceHits.get(allowlistKey) ?? 0) + 1);
        } else {
          add(
            source,
            node,
            'namespace provenance outside allowlist',
            `${allowlistKey}: ${node.getText(source.sourceFile)}`,
          );
        }
      }

      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        propertyName(node.name) === 'loadJobDetail' &&
        node.parameters.some(hasNamespaceProperty)
      ) {
        add(source, node, 'loadJobDetail namespace option', 'loadJobDetail(... namespace ...)');
      }

      if (
        ((ts.isTypeAliasDeclaration(node) && node.name.text === 'JobsListFilters') ||
          (ts.isInterfaceDeclaration(node) && node.name.text === 'JobsListFilters')) &&
        hasNamespaceProperty(node)
      ) {
        add(source, node, 'JobsListFilters.namespace', 'JobsListFilters.namespace');
      }

      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        const allowlistKey = `${source.file}#${node.name.text}`;
        if (STALE_ARTIFACT_ALLOWLIST.has(allowlistKey)) {
          staleArtifactHits.set(allowlistKey, (staleArtifactHits.get(allowlistKey) ?? 0) + 1);
        }
        if (
          node.name.text === 'crashedJobTerminalizationSource' &&
          node.parameters.some((parameter) => propertyName(parameter.name) === 'namespace')
        ) {
          add(
            source,
            node,
            'crashedJobTerminalizationSource namespace parameter',
            'crashedJobTerminalizationSource(namespace)',
          );
        }
      }

      if (ts.isCallExpression(node)) {
        const called = callName(node);
        if (called === 'liveJobCountByNamespace') {
          add(source, node, 'liveJobCountByNamespace call', called);
        }
        if (called === 'countProjectedLiveJobsByNamespace') {
          add(source, node, 'countProjectedLiveJobsByNamespace call', called);
        }
        if (called === 'loadJobDetail' && node.arguments.some(hasNamespaceProperty)) {
          add(source, node, 'loadJobDetail namespace option', 'loadJobDetail namespace argument');
        }
        if (source.file === READ_STORE_FILE && called === 'pluginRootNamespace') {
          add(source, node, 'direct-read pluginRootNamespace derivation', called);
        }
        if (source.file === CORAL_STORE_FILE && enclosingClass(node) === 'CoralStore') {
          const injectsNamespace = node.arguments.some(
            (argument) => hasNamespaceProperty(argument) || hasNamespaceReference(argument),
          );
          if (injectsNamespace && called === 'listJobs') {
            add(source, node, 'CoralStore.jobs.list namespace injection', 'listJobs(... namespace ...)');
          }
          if (injectsNamespace && called === 'loadJobDetail') {
            add(source, node, 'CoralStore.jobs.detail namespace injection', 'loadJobDetail(... namespace ...)');
          }
        }
        if (called === 'crashedJobTerminalizationSource') {
          const namespaceArgument =
            node.arguments.length >= 3 || node.arguments.slice(1).some((argument) => isCurrentNamespace(argument));
          if (namespaceArgument) {
            add(
              source,
              node,
              'crashedJobTerminalizationSource namespace argument',
              'crashedJobTerminalizationSource(... namespace ...)',
            );
          }
        }
      }

      if (ts.isBinaryExpression(node) && isEquality(node)) {
        if (
          insideNamedSymbol(node, 'readOrderedProjectionRows') &&
          ((isOriginBackendNamespace(node.left) && hasNamespaceReference(node.right)) ||
            (isOriginBackendNamespace(node.right) && hasNamespaceReference(node.left)))
        ) {
          add(source, node, 'readOrderedProjectionRows namespace comparison', node.getText(source.sourceFile));
        }
        if (
          isScopedRecoveryFile(source.file) &&
          ((isOriginBackendNamespace(node.left) && isCurrentNamespace(node.right)) ||
            (isOriginBackendNamespace(node.right) && isCurrentNamespace(node.left)))
        ) {
          add(source, node, 'recovery backendNamespace comparison', node.getText(source.sourceFile));
        }
        if (
          (pathText(node.left) === 'launchEventNamespace' && pathText(node.right) === 'namespace') ||
          (pathText(node.right) === 'launchEventNamespace' && pathText(node.left) === 'namespace')
        ) {
          add(source, node, 'launchEventNamespace comparison', node.getText(source.sourceFile));
        }
        if (
          ((isOriginNamespace(node.left) && isCurrentNamespace(node.right)) ||
            (isOriginNamespace(node.right) && isCurrentNamespace(node.left))) &&
          !isScopedRecoveryFile(source.file)
        ) {
          add(source, node, 'origin/current namespace comparison', node.getText(source.sourceFile));
        }
        if (isBundleTenancyComparison(node)) {
          const allowlistKey = `${source.file}#${enclosingSymbol(node)}`;
          if (allowlistKey !== 'src/coordinator/lifecycle.ts#createStaleJobCleanupPolicy') {
            add(source, node, 'bundleHash work-tenancy comparison', node.getText(source.sourceFile));
          }
        }
      }

      const sql = literalText(node);
      if (sql !== null && NAMESPACE_SQL_PREDICATE.test(sql)) {
        const allowlistKey = `${source.file}#${enclosingSymbol(node)}`;
        if (NAMESPACE_SQL_PREDICATE_ALLOWLIST.has(allowlistKey)) {
          namespaceSqlPredicateHits.set(allowlistKey, (namespaceSqlPredicateHits.get(allowlistKey) ?? 0) + 1);
        } else {
          add(source, node, 'namespace equality SQL predicate outside allowlist', `${allowlistKey}: ${sql}`);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source.sourceFile);
  }

  if (options.verifyAllowlist === true) {
    for (const [key, expected] of REBIND_ALLOWLIST) {
      const actual = rebindHits.get(key) ?? 0;
      if (actual !== expected)
        violations.push(`${key}: rebindNamespace allowlist expected ${expected}, found ${actual}`);
    }
    for (const [key, expected] of STALE_ARTIFACT_ALLOWLIST) {
      const actual = staleArtifactHits.get(key) ?? 0;
      if (actual !== expected)
        violations.push(`${key}: stale-artifact allowlist expected ${expected}, found ${actual}`);
    }
    for (const [key, expected] of NAMESPACE_PROVENANCE_ALLOWLIST) {
      const actual = namespaceProvenanceHits.get(key) ?? 0;
      if (actual !== expected)
        violations.push(`${key}: namespace-provenance allowlist expected ${expected}, found ${actual}`);
    }
    for (const [key, expected] of NAMESPACE_SQL_PREDICATE_ALLOWLIST) {
      const actual = namespaceSqlPredicateHits.get(key) ?? 0;
      if (actual !== expected)
        violations.push(`${key}: namespace SQL predicate allowlist expected ${expected}, found ${actual}`);
    }
  }

  return violations.sort();
}

function mutationSource(fixture: MutationFixture): ProductionSource {
  if (fixture.file.endsWith('.sql')) {
    return { kind: 'sql', file: fixture.file, text: fixture.source };
  }
  return {
    kind: 'typescript',
    file: fixture.file,
    text: fixture.source,
    sourceFile: ts.createSourceFile(fixture.file, fixture.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

describe('no build tenancy invariants', () => {
  it('should keep production job ownership independent of build namespace', () => {
    expect(scanNoBuildTenancySources(productionSources(), { verifyAllowlist: true })).toEqual([]);
  });

  it.each(parseMutationFixtures())('should reject $name', (fixture) => {
    const violations = scanNoBuildTenancySources([mutationSource(fixture)]);
    expect(
      violations.some((violation) => violation.includes(`${fixture.file}:`) && violation.includes(fixture.rule)),
      violations.join('\n'),
    ).toBe(true);
  });

  it('should allow event-envelope namespace provenance writes', () => {
    const source = mutationSource({
      name: 'event provenance',
      file: 'src/jobs/reconcile/recovery-effects.ts',
      rule: 'origin/current namespace comparison',
      source: `function markJobAsError(): void { commit.append({ namespace: status.backendNamespace, body: {} }); }`,
    });
    expect(scanNoBuildTenancySources([source])).toEqual([]);
  });
});
