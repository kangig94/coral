import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { codeTextOnly } from '../helpers/ts-code-text.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const FIXTURE_FILE = join(REPO_ROOT, 'tests/invariants/fixtures/no-build-tenancy.ts.txt');
const ACTIVE_MUTATION_ENV = 'NO_BUILD_TENANCY_MUTATION';

const GUARDED_ROOTS = [
  'src/jobs/reconcile/',
  'src/coordinator/services/recovery/',
  'src/coordinator/composition/job-control.ts',
  'src/coordinator/composition/index.ts',
] as const;

const REQUIRED_FILES = [
  'src/jobs/read-queries.ts',
  'src/read-model/coral-store.ts',
  'src/cli/read-store.ts',
  'src/jobs/crashed-job-terminalization-recovery-source.ts',
] as const;

type SourceUnit = Readonly<{
  file: string;
  source: string;
}>;

type SourceInspection = SourceUnit &
  Readonly<{
    code: string;
    sourceFile: ts.SourceFile;
  }>;

type BanRow = Readonly<{
  id: string;
  symbol: string;
  appliesTo(file: string): boolean;
  detects(inspection: SourceInspection): boolean;
}>;

type FixtureMutation = Readonly<{
  file: string;
  source: string;
}>;

type AllowlistEntry = Readonly<{
  file: string;
  reason: string;
  expectedOccurrences: number;
  count(inspection: SourceInspection): number;
}>;

type SourceAnchor = Readonly<{
  file: string;
  count(inspection: SourceInspection): number;
}>;

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(absolute);
      }
    }
  }
  return files.sort();
}

function canonicalPath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replace(/\\/gu, '/');
}

function inspect(unit: SourceUnit): SourceInspection {
  return {
    ...unit,
    code: codeTextOnly(unit.source),
    sourceFile: ts.createSourceFile(unit.file, unit.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

function nodeCount(root: ts.Node, predicate: (node: ts.Node) => boolean): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (predicate(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

function hasNode(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  return nodeCount(root, predicate) > 0;
}

function propertyName(node: { name?: ts.PropertyName }): string | null {
  const { name } = node;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function callName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionPath(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(current)) {
    const parent = expressionPath(current.expression);
    return parent === null ? null : `${parent}.${current.name.text}`;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression !== undefined) {
    const parent = expressionPath(current.expression);
    const argument = unwrapExpression(current.argumentExpression);
    if (parent !== null && (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument))) {
      return `${parent}.${argument.text}`;
    }
  }
  return null;
}

function isEqualityOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function comparisonOperands(node: ts.Node): readonly [ts.Expression, ts.Expression] | null {
  if (ts.isBinaryExpression(node) && isEqualityOperator(node.operatorToken.kind)) {
    return [node.left, node.right];
  }
  if (ts.isCallExpression(node) && expressionPath(node.expression) === 'Object.is' && node.arguments.length === 2) {
    return [node.arguments[0], node.arguments[1]];
  }
  return null;
}

function hasComparison(
  root: ts.Node,
  leftMatches: (path: string) => boolean,
  rightMatches: (path: string) => boolean,
): boolean {
  return hasNode(root, (node) => {
    const operands = comparisonOperands(node);
    if (operands === null) return false;
    const left = expressionPath(operands[0]);
    const right = expressionPath(operands[1]);
    if (left === null || right === null) return false;
    return (leftMatches(left) && rightMatches(right)) || (leftMatches(right) && rightMatches(left));
  });
}

function pathTail(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

function isBackendNamespace(path: string): boolean {
  return pathTail(path) === 'backendNamespace';
}

function isWorldNamespace(path: string): boolean {
  return path === 'world.namespace';
}

function isCurrentNamespace(path: string): boolean {
  return pathTail(path) === 'currentNamespace' || path === 'current.namespace';
}

function isLifecycleNamespace(path: string): boolean {
  return path === 'namespace';
}

function isOriginNamespace(path: string): boolean {
  const tail = pathTail(path);
  return tail === 'origin' || tail === 'originNamespace' || tail === 'origin_namespace' || path === 'origin.namespace';
}

function isLaunchEventNamespace(path: string): boolean {
  return pathTail(path) === 'launchEventNamespace';
}

function isNamespaceValued(path: string): boolean {
  const tail = pathTail(path);
  return tail === 'namespace' || /Namespace$/u.test(tail) || /_namespace$/u.test(tail);
}

function matchesComparisonPair(
  left: string,
  right: string,
  leftMatches: (path: string) => boolean,
  rightMatches: (path: string) => boolean,
): boolean {
  return (leftMatches(left) && rightMatches(right)) || (leftMatches(right) && rightMatches(left));
}

function isSpecificallyDiagnosedNamespaceComparison(left: string, right: string): boolean {
  return (
    matchesComparisonPair(left, right, isBackendNamespace, isWorldNamespace) ||
    matchesComparisonPair(left, right, isBackendNamespace, isCurrentNamespace) ||
    matchesComparisonPair(left, right, isBackendNamespace, isLifecycleNamespace) ||
    matchesComparisonPair(left, right, isLaunchEventNamespace, isLifecycleNamespace)
  );
}

function hasNamespaceValuedComparison(root: ts.Node): boolean {
  return hasNode(root, (node) => {
    const operands = comparisonOperands(node);
    if (operands === null) return false;
    const left = expressionPath(operands[0]);
    const right = expressionPath(operands[1]);
    if (left === null || right === null) return false;
    return (
      isNamespaceValued(left) && isNamespaceValued(right) && !isSpecificallyDiagnosedNamespaceComparison(left, right)
    );
  });
}

function isReadProjectionNamespace(path: string): boolean {
  return path === 'row.backend_namespace';
}

function isReadFilterNamespace(path: string): boolean {
  return path === 'filters.namespace';
}

function namedScopes(root: ts.Node, name: string): ts.Node[] {
  const scopes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) &&
        propertyName(node) === name) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    ) {
      scopes.push(ts.isVariableDeclaration(node) ? node.initializer! : node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return scopes;
}

function countInNamedScope(
  inspection: SourceInspection,
  scopeName: string,
  predicate: (node: ts.Node) => boolean,
): number {
  return namedScopes(inspection.sourceFile, scopeName).reduce((total, scope) => total + nodeCount(scope, predicate), 0);
}

function isNamedProperty(node: ts.Node, name: string): node is ts.PropertyAssignment {
  return ts.isPropertyAssignment(node) && propertyName(node) === name;
}

function propertyWritesPath(node: ts.Node, property: string, valuePath: string): boolean {
  return isNamedProperty(node, property) && expressionPath(node.initializer) === valuePath;
}

function callObjectPropertyWritesPath(node: ts.Node, calleeName: string, property: string, valuePath: string): boolean {
  return (
    ts.isCallExpression(node) &&
    callName(node) === calleeName &&
    node.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some((candidate) => propertyWritesPath(candidate, property, valuePath)),
    )
  );
}

function newObjectPropertyWritesPath(
  node: ts.Node,
  constructorName: string,
  property: string,
  valuePath: string,
): boolean {
  return (
    ts.isNewExpression(node) &&
    expressionPath(node.expression) === constructorName &&
    (node.arguments ?? []).some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some((candidate) => propertyWritesPath(candidate, property, valuePath)),
    )
  );
}

function functionHasNamespaceOption(sourceFile: ts.SourceFile): boolean {
  return hasNode(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== 'loadJobDetail') return false;
    return node.parameters.some(
      (parameter) =>
        (ts.isIdentifier(parameter.name) && parameter.name.text === 'namespace') ||
        (parameter.type !== undefined &&
          hasNode(
            parameter.type,
            (candidate) =>
              (ts.isPropertySignature(candidate) || ts.isPropertyDeclaration(candidate)) &&
              propertyName(candidate) === 'namespace',
          )),
    );
  });
}

function jobsListFiltersHasNamespace(sourceFile: ts.SourceFile): boolean {
  return hasNode(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'JobsListFilters' && ts.isTypeLiteralNode(node.type)) {
      return node.type.members.some((member) => propertyName(member) === 'namespace');
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'JobsListFilters') {
      return node.members.some((member) => propertyName(member) === 'namespace');
    }
    return false;
  });
}

function readOrderedProjectionRowsComparesNamespace(sourceFile: ts.SourceFile): boolean {
  return namedScopes(sourceFile, 'readOrderedProjectionRows').some((scope) =>
    hasComparison(scope, isReadProjectionNamespace, isReadFilterNamespace),
  );
}

function coralJobsObjects(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      expressionPath(node.left) === 'this.jobs' &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      objects.push(node.right);
    }
    if (
      ts.isPropertyDeclaration(node) &&
      propertyName(node) === 'jobs' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      objects.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return objects;
}

function coralJobsMemberInjectsNamespace(sourceFile: ts.SourceFile, memberName: 'list' | 'detail'): boolean {
  return coralJobsObjects(sourceFile).some((object) => {
    const member = object.properties.find((candidate) => propertyName(candidate) === memberName);
    if (member === undefined) return false;
    return hasNode(
      member,
      (node) =>
        (isNamedProperty(node, 'namespace') && true) ||
        (ts.isPropertyAccessExpression(node) && expressionPath(node) === 'this.namespace'),
    );
  });
}

function guardedComparisonFile(file: string): boolean {
  return GUARDED_ROOTS.some((root) => (root.endsWith('/') ? file.startsWith(root) : file === root));
}

function callsNamedMethod(sourceFile: ts.SourceFile, methodName: string): boolean {
  return hasNode(sourceFile, (node) => ts.isCallExpression(node) && callName(node) === methodName);
}

function crashedSourceHasNamespaceParameter(sourceFile: ts.SourceFile): boolean {
  return namedScopes(sourceFile, 'crashedJobTerminalizationSource').some((scope) => {
    if (!ts.isFunctionLike(scope)) return false;
    return scope.parameters.some(
      (parameter) => ts.isIdentifier(parameter.name) && /namespace/iu.test(parameter.name.text),
    );
  });
}

function isNamespaceArgument(expression: ts.Expression): boolean {
  const path = expressionPath(expression);
  return path !== null && (path === 'namespace' || /Namespace$/u.test(pathTail(path)) || path.endsWith('.namespace'));
}

function callsCrashedSourceWithNamespace(sourceFile: ts.SourceFile): boolean {
  return hasNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || callName(node) !== 'crashedJobTerminalizationSource') return false;
    return node.arguments.length >= 3 || (node.arguments[1] !== undefined && isNamespaceArgument(node.arguments[1]));
  });
}

function containsCrashedSourceSqlPredicate(sourceFile: ts.SourceFile): boolean {
  return hasNode(sourceFile, (node) => {
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node)) {
      return false;
    }
    return /\bbackend_namespace\s*=\s*\?/u.test(node.getText(sourceFile));
  });
}

function exactSymbol(symbol: string): RegExp {
  return new RegExp(`(^|[^\\w$])${symbol}(?![\\w$])`, 'u');
}

const BANNED_ROWS: readonly BanRow[] = [
  {
    id: 'belongs-to-namespace',
    symbol: 'belongsToNamespace',
    appliesTo: () => true,
    detects: ({ code }) => exactSymbol('belongsToNamespace').test(code),
  },
  {
    id: 'live-job-count-by-namespace',
    symbol: 'liveJobCountByNamespace()',
    appliesTo: () => true,
    detects: ({ sourceFile }) => callsNamedMethod(sourceFile, 'liveJobCountByNamespace'),
  },
  {
    id: 'count-projected-live-jobs-by-namespace',
    symbol: 'countProjectedLiveJobsByNamespace()',
    appliesTo: () => true,
    detects: ({ sourceFile }) => callsNamedMethod(sourceFile, 'countProjectedLiveJobsByNamespace'),
  },
  {
    id: 'load-job-detail-namespace-option',
    symbol: 'loadJobDetail options.namespace',
    appliesTo: (file) => file === 'src/jobs/read-queries.ts',
    detects: ({ sourceFile }) => functionHasNamespaceOption(sourceFile),
  },
  {
    id: 'jobs-list-filters-namespace',
    symbol: 'JobsListFilters.namespace',
    appliesTo: (file) => file === 'src/jobs/read-queries.ts',
    detects: ({ sourceFile }) => jobsListFiltersHasNamespace(sourceFile),
  },
  {
    id: 'read-ordered-projection-namespace-comparison',
    symbol: 'readOrderedProjectionRows row.backend_namespace/filters.namespace comparison',
    appliesTo: (file) => file === 'src/jobs/read-queries.ts',
    detects: ({ sourceFile }) => readOrderedProjectionRowsComparesNamespace(sourceFile),
  },
  {
    id: 'coral-store-jobs-list-namespace-injection',
    symbol: 'CoralStore.jobs.list namespace injection',
    appliesTo: (file) => file === 'src/read-model/coral-store.ts',
    detects: ({ sourceFile }) => coralJobsMemberInjectsNamespace(sourceFile, 'list'),
  },
  {
    id: 'coral-store-jobs-detail-namespace-injection',
    symbol: 'CoralStore.jobs.detail namespace injection',
    appliesTo: (file) => file === 'src/read-model/coral-store.ts',
    detects: ({ sourceFile }) => coralJobsMemberInjectsNamespace(sourceFile, 'detail'),
  },
  {
    id: 'direct-read-plugin-root-namespace',
    symbol: 'pluginRootNamespace direct-job-read derivation',
    appliesTo: (file) => file === 'src/cli/read-store.ts',
    detects: ({ code }) => exactSymbol('pluginRootNamespace').test(code),
  },
  {
    id: 'backend-world-namespace-comparison',
    symbol: 'backendNamespace/world.namespace equality comparison',
    appliesTo: guardedComparisonFile,
    detects: ({ sourceFile }) => hasComparison(sourceFile, isBackendNamespace, isWorldNamespace),
  },
  {
    id: 'backend-current-namespace-comparison',
    symbol: 'backendNamespace/currentNamespace equality comparison',
    appliesTo: guardedComparisonFile,
    detects: ({ sourceFile }) => hasComparison(sourceFile, isBackendNamespace, isCurrentNamespace),
  },
  {
    id: 'backend-lifecycle-namespace-comparison',
    symbol: 'backendNamespace/lifecycle namespace equality comparison',
    appliesTo: guardedComparisonFile,
    detects: ({ sourceFile }) => hasComparison(sourceFile, isBackendNamespace, isLifecycleNamespace),
  },
  {
    id: 'namespace-valued-equality-comparison',
    symbol: 'namespace-valued expression equality comparison',
    appliesTo: guardedComparisonFile,
    detects: ({ sourceFile }) => hasNamespaceValuedComparison(sourceFile),
  },
  {
    id: 'adopt-orphaned-cross-namespace-jobs',
    symbol: 'adoptOrphanedCrossNamespaceJobs',
    appliesTo: () => true,
    detects: ({ code }) => exactSymbol('adoptOrphanedCrossNamespaceJobs').test(code),
  },
  {
    id: 'origin-current-namespace-comparison',
    symbol: 'origin/current namespace equality comparison',
    appliesTo: () => true,
    detects: ({ sourceFile }) => hasComparison(sourceFile, isOriginNamespace, isCurrentNamespace),
  },
  {
    id: 'launch-event-lifecycle-namespace-comparison',
    symbol: 'launchEventNamespace/lifecycle namespace equality comparison',
    appliesTo: () => true,
    detects: ({ sourceFile }) => hasComparison(sourceFile, isLaunchEventNamespace, isLifecycleNamespace),
  },
  {
    id: 'crashed-source-namespace-parameter',
    symbol: 'crashedJobTerminalizationSource namespace parameter',
    appliesTo: (file) => file === 'src/jobs/crashed-job-terminalization-recovery-source.ts',
    detects: ({ sourceFile }) => crashedSourceHasNamespaceParameter(sourceFile),
  },
  {
    id: 'crashed-source-namespace-argument',
    symbol: 'crashedJobTerminalizationSource namespace argument',
    appliesTo: () => true,
    detects: ({ sourceFile }) => callsCrashedSourceWithNamespace(sourceFile),
  },
  {
    id: 'crashed-source-backend-namespace-sql',
    symbol: 'backend_namespace = ?',
    appliesTo: (file) => file === 'src/jobs/crashed-job-terminalization-recovery-source.ts',
    detects: ({ sourceFile }) => containsCrashedSourceSqlPredicate(sourceFile),
  },
];

const LEGITIMATE_BUILD_IDENTITY_ALLOWLIST = new Map<string, AllowlistEntry>([
  [
    'src/coordinator/lifecycle.ts#createStaleJobCleanupPolicy.fromOldBundle',
    {
      file: 'src/coordinator/lifecycle.ts',
      reason: 'bundle identity only prunes terminal export artifacts; it never selects recoverable work',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'createStaleJobCleanupPolicy', (node) => {
          const operands = comparisonOperands(node);
          if (operands === null) return false;
          const paths = operands.map(expressionPath);
          return paths.includes('item.bundleHash') && paths.includes('currentBundleHash');
        }),
    },
  ],
  [
    'src/jobs/stale-job-cleanup-recovery-source.ts#staleJobCleanupSource',
    {
      file: 'src/jobs/stale-job-cleanup-recovery-source.ts',
      reason: 'the recovery source enumerates terminal-only cleanup candidates without a namespace predicate',
      expectedOccurrences: 1,
      count: ({ sourceFile }) => namedScopes(sourceFile, 'staleJobCleanupSource').length,
    },
  ],
  [
    'src/coordinator/startup-recovery.ts#runStartupStaleArtifactPrune',
    {
      file: 'src/coordinator/startup-recovery.ts',
      reason: 'the startup runner contains the terminal-artifact prune and has no work-tenancy authority',
      expectedOccurrences: 1,
      count: ({ sourceFile }) => namedScopes(sourceFile, 'runStartupStaleArtifactPrune').length,
    },
  ],
  [
    'src/jobs/contracts/job-store.ts#JobProgressStore.rebindNamespace',
    {
      file: 'src/jobs/contracts/job-store.ts',
      reason: 'recovery may update rendered provenance after it has independently acquired the job',
      expectedOccurrences: 1,
      count: ({ sourceFile }) =>
        nodeCount(sourceFile, (node) => ts.isMethodSignature(node) && propertyName(node) === 'rebindNamespace'),
    },
  ],
  [
    'src/jobs/store.ts#JobStore.rebindNamespace',
    {
      file: 'src/jobs/store.ts',
      reason: 'the implementation updates display/event provenance and never decides whether recovery owns a job',
      expectedOccurrences: 1,
      count: ({ sourceFile }) =>
        nodeCount(sourceFile, (node) => ts.isMethodDeclaration(node) && propertyName(node) === 'rebindNamespace'),
    },
  ],
  [
    'src/coordinator/services/recovery/service.ts#RecoveryService.recoverQueuedJob.rebindNamespace',
    {
      file: 'src/coordinator/services/recovery/service.ts',
      reason: 'queued recovery rebinds provenance only after recovery authority was established',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(
          inspection,
          'recoverQueuedJob',
          (node) => ts.isCallExpression(node) && callName(node) === 'rebindNamespace',
        ),
    },
  ],
  [
    'src/coordinator/services/recovery/service.ts#RecoveryService.adoptRunningJob.rebindNamespace',
    {
      file: 'src/coordinator/services/recovery/service.ts',
      reason: 'running recovery rebinds provenance only after recovery authority was established',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(
          inspection,
          'adoptRunningJob',
          (node) => ts.isCallExpression(node) && callName(node) === 'rebindNamespace',
        ),
    },
  ],
  [
    'src/coordinator/composition/index.ts#createExecutionServices.backendNamespace',
    {
      file: 'src/coordinator/composition/index.ts',
      reason: 'new execution events record the coordinator namespace as provenance',
      expectedOccurrences: 1,
      count: ({ sourceFile }) =>
        nodeCount(sourceFile, (node) =>
          callObjectPropertyWritesPath(node, 'createExecutionServices', 'backendNamespace', 'world.namespace'),
        ),
    },
  ],
  [
    'src/coordinator/composition/index.ts#KbJobRecorder.backendNamespace',
    {
      file: 'src/coordinator/composition/index.ts',
      reason: 'new KB lifecycle events record the coordinator namespace as provenance',
      expectedOccurrences: 1,
      count: ({ sourceFile }) =>
        nodeCount(sourceFile, (node) =>
          newObjectPropertyWritesPath(node, 'KbJobRecorder', 'backendNamespace', 'world.namespace'),
        ),
    },
  ],
  [
    'src/coordinator/composition/index.ts#recordHostedKbFailure.namespace',
    {
      file: 'src/coordinator/composition/index.ts',
      reason: 'the hosted-KB failure event preserves the recovered job envelope namespace',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'recordHostedKbFailure', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/jobs/reconcile/recovery-effects.ts#markJobAsError.namespace',
    {
      file: 'src/jobs/reconcile/recovery-effects.ts',
      reason: 'the terminal event envelope preserves the job namespace as provenance',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'markJobAsError', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/jobs/reconcile/recovery-effects.ts#recoveryFaultOutcome.namespace',
    {
      file: 'src/jobs/reconcile/recovery-effects.ts',
      reason: 'the progress event envelope preserves the job namespace as provenance',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'recoveryFaultOutcome', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/coordinator/services/recovery/index.ts#settleCoordinatorRecoveryItem.namespace',
    {
      file: 'src/coordinator/services/recovery/index.ts',
      reason: 'both coordinator-recovery terminal envelope forms preserve provenance after settlement',
      expectedOccurrences: 2,
      count: (inspection) =>
        countInNamedScope(inspection, 'settleCoordinatorRecoveryItem', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/coordinator/services/recovery/interrupted-finalizer.ts#finalizeInterruptedAppServerRecovery.namespace',
    {
      file: 'src/coordinator/services/recovery/interrupted-finalizer.ts',
      reason: 'the interrupted app-server terminal envelope preserves provenance after recovery',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'finalizeInterruptedAppServerRecovery', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/coordinator/services/recovery/interrupted-finalizer.ts#directTerminalAppender.namespace',
    {
      file: 'src/coordinator/services/recovery/interrupted-finalizer.ts',
      reason: 'the direct terminal event envelope preserves provenance after recovery',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'directTerminalAppender', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/coordinator/services/recovery/interrupted-finalizer.ts#finalizeInterruptedDurableRecovery.namespace',
    {
      file: 'src/coordinator/services/recovery/interrupted-finalizer.ts',
      reason: 'the interrupted durable terminal envelope preserves provenance after recovery',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'finalizeInterruptedDurableRecovery', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/coordinator/lifecycle.ts#createCrashedJobTerminalizationPolicy.namespace',
    {
      file: 'src/coordinator/lifecycle.ts',
      reason: 'crash terminalization writes the stored job namespace into the terminal event envelope',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'createCrashedJobTerminalizationPolicy', (node) =>
          propertyWritesPath(node, 'namespace', 'status.backendNamespace'),
        ),
    },
  ],
  [
    'src/jobs/store.ts#jobLaunchRequestedEvent.namespace',
    {
      file: 'src/jobs/store.ts',
      reason: 'a launch event records its originating namespace as envelope provenance',
      expectedOccurrences: 1,
      count: (inspection) =>
        countInNamedScope(inspection, 'jobLaunchRequestedEvent', (node) =>
          propertyWritesPath(node, 'namespace', 'launch.backendNamespace'),
        ),
    },
  ],
]);

const REQUIRED_SOURCE_ANCHORS = new Map<string, SourceAnchor>([
  [
    'loadJobDetail',
    {
      file: 'src/jobs/read-queries.ts',
      count: ({ sourceFile }) => namedScopes(sourceFile, 'loadJobDetail').length,
    },
  ],
  [
    'JobsListFilters',
    {
      file: 'src/jobs/read-queries.ts',
      count: ({ sourceFile }) =>
        nodeCount(
          sourceFile,
          (node) =>
            (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
            node.name.text === 'JobsListFilters',
        ),
    },
  ],
  [
    'readOrderedProjectionRows',
    {
      file: 'src/jobs/read-queries.ts',
      count: ({ sourceFile }) => namedScopes(sourceFile, 'readOrderedProjectionRows').length,
    },
  ],
  [
    'CoralStore.jobs.list/detail',
    {
      file: 'src/read-model/coral-store.ts',
      count: ({ sourceFile }) =>
        coralJobsObjects(sourceFile).filter((object) =>
          ['list', 'detail'].every((member) => object.properties.some((property) => propertyName(property) === member)),
        ).length,
    },
  ],
  [
    'openReadCoralStore',
    {
      file: 'src/cli/read-store.ts',
      count: ({ sourceFile }) => namedScopes(sourceFile, 'openReadCoralStore').length,
    },
  ],
  [
    'crashedJobTerminalizationSource',
    {
      file: 'src/jobs/crashed-job-terminalization-recovery-source.ts',
      count: ({ sourceFile }) => namedScopes(sourceFile, 'crashedJobTerminalizationSource').length,
    },
  ],
]);

function violation(row: BanRow, file: string): string {
  return `${row.symbol} — ${file}`;
}

function collectViolations(inspections: readonly SourceInspection[]): string[] {
  return inspections
    .flatMap((inspection) =>
      BANNED_ROWS.filter((row) => row.appliesTo(inspection.file) && row.detects(inspection)).map((row) =>
        violation(row, inspection.file),
      ),
    )
    .sort();
}

function readFixtureMutations(): ReadonlyMap<string, FixtureMutation> {
  const mutations = new Map<string, FixtureMutation>();
  const lines = readFileSync(FIXTURE_FILE, 'utf8').split('\n');
  let active: { id: string; file: string; lines: string[] } | null = null;
  for (const line of lines) {
    const header = /^\/\/ @mutation ([a-z0-9-]+) (src\/\S+)$/u.exec(line);
    if (header !== null) {
      if (active !== null) throw new Error(`Nested no-build-tenancy fixture mutation: ${header[1]}`);
      active = { id: header[1], file: header[2], lines: [] };
      continue;
    }
    if (line === '// @end') {
      if (active === null) throw new Error('Unexpected no-build-tenancy fixture mutation end marker.');
      if (mutations.has(active.id)) throw new Error(`Duplicate no-build-tenancy fixture mutation: ${active.id}`);
      mutations.set(active.id, { file: active.file, source: active.lines.join('\n') });
      active = null;
      continue;
    }
    if (active !== null) active.lines.push(line);
  }
  if (active !== null) throw new Error(`Unterminated no-build-tenancy fixture mutation: ${active.id}`);
  return mutations;
}

const PRODUCTION_UNITS: readonly SourceUnit[] = listTypeScriptFiles(SRC_ROOT).map((filePath) => ({
  file: canonicalPath(filePath),
  source: readFileSync(filePath, 'utf8'),
}));
const PRODUCTION_INSPECTIONS = PRODUCTION_UNITS.map(inspect);
const PRODUCTION_FILES = new Set(PRODUCTION_UNITS.map(({ file }) => file));
const FIXTURE_MUTATIONS = readFixtureMutations();
const ADDITIONAL_MUTATION_EXPECTATIONS = [
  {
    id: 'namespace-valued-equality-comparison-reconcile',
    rowId: 'namespace-valued-equality-comparison',
  },
  {
    id: 'non-namespace-equality-control',
    rowId: null,
  },
] as const;

function productionWithSelectedMutation(): SourceInspection[] {
  const selected = process.env[ACTIVE_MUTATION_ENV];
  if (selected === undefined || selected.length === 0) return [...PRODUCTION_INSPECTIONS];
  const mutation = FIXTURE_MUTATIONS.get(selected);
  if (mutation === undefined) throw new Error(`Unknown ${ACTIVE_MUTATION_ENV}: ${selected}`);

  let applied = false;
  const mutated = PRODUCTION_UNITS.map((unit): SourceUnit => {
    if (unit.file !== mutation.file) return unit;
    applied = true;
    return { ...unit, source: `${unit.source}\n${mutation.source}\n` };
  });
  if (!applied) mutated.push(mutation);
  return mutated.map(inspect);
}

function matchesRoot(file: string, root: string): boolean {
  return root.endsWith('/') ? file.startsWith(root) : file === root;
}

describe('production job work is never tenanted by build namespace', () => {
  it('scans production source and every guarded root non-vacuously', () => {
    expect(PRODUCTION_FILES.size).toBeGreaterThan(0);
    expect(REQUIRED_FILES.filter((file) => !PRODUCTION_FILES.has(file))).toEqual([]);
    expect(GUARDED_ROOTS.filter((root) => ![...PRODUCTION_FILES].some((file) => matchesRoot(file, root)))).toEqual([]);
    const missingAnchors = [...REQUIRED_SOURCE_ANCHORS.entries()].flatMap(([symbol, anchor]) => {
      const inspection = PRODUCTION_INSPECTIONS.find(({ file }) => file === anchor.file);
      const observed = inspection === undefined ? 0 : anchor.count(inspection);
      return observed === 1 ? [] : [`${symbol} — ${anchor.file}: expected 1, observed ${observed}`];
    });
    expect(missingAnchors).toEqual([]);
  });

  it('contains every banned-row mutation and required comparison control', () => {
    const expected = [
      ...BANNED_ROWS.map(({ id }) => id),
      ...ADDITIONAL_MUTATION_EXPECTATIONS.map(({ id }) => id),
    ].sort();
    expect([...FIXTURE_MUTATIONS.keys()].sort()).toEqual(expected);
  });

  it.each(BANNED_ROWS.map((row) => [row.id, row] as const))(
    'rejects the %s fixture mutation for its own signature',
    (id, row) => {
      const mutation = FIXTURE_MUTATIONS.get(id);
      expect(mutation, `missing fixture mutation for ${id}`).toBeDefined();
      if (mutation === undefined) return;
      expect(collectViolations([inspect(mutation)])).toEqual([violation(row, mutation.file)]);
    },
  );

  it.each(ADDITIONAL_MUTATION_EXPECTATIONS)(
    'handles the $id fixture mutation with the intended namespace-equality scope',
    ({ id, rowId }) => {
      const mutation = FIXTURE_MUTATIONS.get(id);
      expect(mutation, `missing fixture mutation for ${id}`).toBeDefined();
      if (mutation === undefined) return;
      const row = rowId === null ? undefined : BANNED_ROWS.find(({ id: candidate }) => candidate === rowId);
      expect(rowId === null || row !== undefined, `missing banned row for ${id}`).toBe(true);
      expect(collectViolations([inspect(mutation)])).toEqual(row === undefined ? [] : [violation(row, mutation.file)]);
    },
  );

  it('keeps every legitimate namespace/build use pinned to its exact symbol and file', () => {
    const stale = [...LEGITIMATE_BUILD_IDENTITY_ALLOWLIST.entries()].flatMap(([symbol, entry]) => {
      const inspection = PRODUCTION_INSPECTIONS.find(({ file }) => file === entry.file);
      const observed = inspection === undefined ? 0 : entry.count(inspection);
      return observed === entry.expectedOccurrences
        ? []
        : [`${symbol}: expected ${entry.expectedOccurrences}, observed ${observed}; reason: ${entry.reason}`];
    });
    expect(stale).toEqual([]);
  });

  it('finds no forbidden build-tenancy signature in production source', () => {
    const violations = collectViolations(productionWithSelectedMutation());
    const diagnostic =
      violations.length === 0
        ? 'no build-tenancy violations'
        : `Forbidden build-tenancy source:\n${violations.map((entry) => `- ${entry}`).join('\n')}`;
    expect(violations, diagnostic).toEqual([]);
  });
});
