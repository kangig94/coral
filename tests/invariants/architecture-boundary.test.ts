/*
Architectural boundary guard for seams established by:
- e34d8d8: workflow/ may depend on provider discovery only through src/providers/catalog.ts, not provider implementations or provider internals.
This test enforces those boundaries with the TypeScript compiler API and treats import type, export ... from, typeof import('...'), and relative dynamic import('...') as boundary-crossing imports.
Known non-goals: computed import(variableName) and relative require('...') are intentionally not covered.
*/

// Shared scanning helpers stay extracted because the reused resolver and AST import scanner exceed the inline duplication threshold.
import { dirname, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  createProductionFileIndex,
  listProductionSourceFiles,
  parseSourceImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from '#tests/helpers/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

const WORKFLOW_ROOT = 'src/workflow';
const JOBS_ROOT = 'src/jobs';
const JOBS_RECONCILE_ROOT = 'src/jobs/reconcile';
const JOBS_SHELL_ROOT = 'src/jobs/shell';
const KB_ROOT = 'src/kb';
const COORDINATOR_ROOT = 'src/coordinator';
const COORDINATOR_SERVICES_ROOT = 'src/coordinator/services';
const RUNTIME_ROOT = 'src/runtime';
const EXECUTION_ROOT = ['src', 'execution'].join('/');
const CLIENT_ROOT = ['src', 'client'].join('/');
const SKILLS_ROOT = ['src', 'skills'].join('/');
const SHARED_ROOT = ['src', 'shared'].join('/');
const SIMULATION_ROOT = ['src', 'simulation'].join('/');
const RETIRED_PRIVATE_STATE_ROOT = ['src', ['_', 'le', 'gacy'].join('')].join('/');
const ROOT_SCENARIOS_ROOT = 'scenarios';
const DEBUG_SIMULATION_SCENARIOS_ROOT = ['tools', 'simulation', 'scenarios'].join('/');
const RETIRED_RUNTIME_MODULE = ['src', 'execution', 'runtime.ts'].join('/');
const RETIRED_RUNTIME_PORTS = ['src', 'shared', 'runtime-ports.ts'].join('/');
const RETIRED_RUNTIME_FLAVOR = ['src', 'runtime', 'flavor.ts'].join('/');
const RETIRED_KB_API = ['src', 'kb', 'api.ts'].join('/');
const RETIRED_SESSIONS_API = ['src', 'sessions', 'api.ts'].join('/');
const RETIRED_JOBS_VIEWS = ['src', 'jobs', 'views.ts'].join('/');
const RETIRED_PROVIDERS_API = ['src', 'providers', 'api.ts'].join('/');
const RETIRED_PROVIDERS_CONTINUITY_MUTATION = ['src', 'providers', 'continuity-mutation.ts'].join('/');
const RETIRED_HTTP_CLIENT = ['src', 'transport', 'http', 'http-client.ts'].join('/');
const RETIRED_HTTP_CONTRACTS = ['src', 'transport', 'http', 'contracts.ts'].join('/');
const RETIRED_HTTP_WAIT_STREAM = ['src', 'transport', 'http', 'wait-stream.ts'].join('/');
const RETIRED_HTTP_TOOL_RESPONSE = ['src', 'transport', 'http', 'tool-response.ts'].join('/');
const RETIRED_JOBS_INDEX = ['src', 'jobs', 'index.ts'].join('/');
const RETIRED_SESSIONS_INDEX = ['src', 'sessions', 'index.ts'].join('/');
const RETIRED_TRANSPORT_HTTP_INDEX = ['src', 'transport', 'http', 'index.ts'].join('/');
const RETIRED_COORDINATOR_INDEX = ['src', 'coordinator', 'index.ts'].join('/');
const RETIRED_WORKFLOW_INDEX = ['src', 'workflow', 'index.ts'].join('/');
const RETIRED_RUNTIME_INDEX = ['src', 'runtime', 'index.ts'].join('/');
const RETIRED_DISCUSS_API = ['src', 'discuss', 'api.ts'].join('/');
const RETIRED_DISCUSS_VIEWS = ['src', 'discuss', 'views.ts'].join('/');
const RETIRED_DISCUSS_TIME_UTIL = ['src', 'discuss', 'util', 'time.ts'].join('/');
const RETIRED_COORDINATOR_LOG = ['src', 'coordinator', 'log.ts'].join('/');
const RETIRED_EXPORTS_PATHS = ['src', 'jobs', 'exports', 'paths.ts'].join('/');
const RETIRED_CORPUS_PATHS = ['src', 'kb', 'corpus', 'paths.ts'].join('/');
const RETIRED_INFRA_INDEX = ['src', 'infra', 'index.ts'].join('/');
const RETIRED_SIMULATION_INDEX = ['src', 'simulation', 'index.ts'].join('/');
const RETIRED_SIMULATION_CORE_INDEX = ['src', 'simulation', 'core', 'index.ts'].join('/');
const RETIRED_INFRA_REQUEST_CONTEXT = ['src', 'infra', 'request-context.ts'].join('/');
const RETIRED_TRANSPORT_REQUEST_CONTEXT = ['src', 'transport', 'request-context.ts'].join('/');
const RETIRED_TRANSPORT_SHARED_CONTEXT = ['src', 'transport', 'shared-context.ts'].join('/');
const RETIRED_COORDINATOR_CALLER_CONTEXT = ['src', 'coordinator', 'caller-context.ts'].join('/');
const RETIRED_STORE_CORPUS_CONSUMER = ['src', 'store', 'corpus-consumer.ts'].join('/');
const RETIRED_KB_CORPUS_REPAIR_TYPES = ['src', 'kb', 'corpus', 'repair', 'types.ts'].join('/');
const RETIRED_SIMULATION_WORLD = ['src', 'simulation', 'world.ts'].join('/');
const RETIRED_SIMULATION_SCHEMA = ['src', 'simulation', 'schema.ts'].join('/');
const RETIRED_SIMULATION_NORMALIZE = ['src', 'simulation', 'normalize.ts'].join('/');
const RETIRED_JOB_HELPERS = ['src', 'jobs', 'reconcile', 'job-helpers.ts'].join('/');
const RETIRED_CURATE_SHARED = ['src', 'kb', 'curate', 'shared.ts'].join('/');
const RETIRED_CURATE_STATE_SHARED = ['src', 'kb', 'curate', 'state-shared.ts'].join('/');
const RETIRED_CLAUDE_SHARED_UTILS = ['src', 'providers', 'claude', 'shared-utils.ts'].join('/');
const RETIRED_STRATEGY_SHARED = ['src', 'expansion', 'strategies', 'shared.ts'].join('/');
const RETIRED_WORKFLOW_INTERNAL_SHARED = ['src', 'workflow', 'internal', 'shared.ts'].join('/');
const RETIRED_DISCUSS_READ_HELPERS = ['src', 'discuss', 'shell', 'read-helpers.ts'].join('/');
const RETIRED_DISCUSS_FLOW_SHARED = ['src', 'discuss', 'shell', 'flow-shared.ts'].join('/');
const RETIRED_DISCUSS_STATE_HELPERS = ['src', 'discuss', 'state-helpers.ts'].join('/');
const RETIRED_HTTP_BACKEND_HELPERS = ['src', 'transport', 'http', 'backend-helpers.ts'].join('/');
const RETIRED_KB_MUTATION_HELPERS = ['src', 'kb', 'corpus', 'mutation-helpers.ts'].join('/');
const RETIRED_COMMAND_HELPERS = ['src', 'cli', 'command-helpers.ts'].join('/');
const RETIRED_COORDINATOR_EXECUTION_SHARED = ['src', 'coordinator', 'services', 'execution-shared.ts'].join('/');
const RETIRED_STORE_KB_QUERIES = ['src', 'store', 'queries', 'kb.ts'].join('/');
const RETIRED_STORE_JOB_QUERIES = ['src', 'store', 'queries', 'jobs.ts'].join('/');
const RETIRED_STORE_DISCUSS_QUERIES = ['src', 'store', 'queries', 'discuss.ts'].join('/');
const RETIRED_STORE_SESSION_QUERIES = ['src', 'store', 'queries', 'sessions.ts'].join('/');
const RETIRED_STORE_WORKFLOW_QUERIES = ['src', 'store', 'queries', 'workflows.ts'].join('/');
const RETIRED_STORE_CORAL_STORE = ['src', 'store', 'coral-store.ts'].join('/');
const RETIRED_STORE_READ_CONTEXT = ['src', 'store', 'read-context.ts'].join('/');
const RETIRED_STORE_PATHS = ['src', 'store', 'paths.ts'].join('/');
const RETIRED_STORE_CAUSE_REF = ['src', 'store', 'cause-ref.ts'].join('/');
const RETIRED_STORE_CORPUS_STATE = ['src', 'store', 'corpus-state.ts'].join('/');
const RETIRED_STORE_SCHEMA_SQL = ['src', 'store', 'schema.sql'].join('/');
const RETIRED_STORE_MIGRATIONS_MODULE = ['src', 'store', 'migrations.ts'].join('/');
const RETIRED_STORE_MIGRATIONS_DIR = ['src', 'store', 'migrations'].join('/');
const RETIRED_STORE_SCHEMAS_MODULE = ['src', 'store', 'schemas.ts'].join('/');
const RETIRED_SESSION_JSON_READER = ['src', 'sessions', 'shell', 'session-read.ts'].join('/');
const RETIRED_JOBS_SHELL_FAULT_MATERIALIZER = ['src', 'jobs', 'shell', 'fault-materializer.ts'].join('/');
const RETIRED_JOBS_SHELL_CONTRACTS = ['src', 'jobs', 'shell', 'contracts.ts'].join('/');
const RETIRED_JOBS_SHELL_AGENT_RESOLUTION = ['src', 'jobs', 'shell', 'agent-resolution.ts'].join('/');
const RETIRED_SESSIONS_SHELL_RESOLVE = ['src', 'sessions', 'shell', 'resolve.ts'].join('/');
const RETIRED_DISCUSS_RECONCILE = ['src', 'discuss', 'reconcile.ts'].join('/');
const RETIRED_BRIDGE_MANIFEST = ['src', 'infra', 'bridge-manifest.ts'].join('/');
const RETIRED_STATUS_SCHEMA_FAULT = ['stale', 'status', 'schema'].join('_');
const RETIRED_TEXT_ARTIFACT_LOCK_METHOD = ['ensureTextArtifacts', 'FreshUnderLock'].join('');
const RETIRED_COORDINATOR_SHIMS = [
  ['src', 'coordinator', 'discovery.ts'].join('/'),
  ['src', 'coordinator', 'paths.ts'].join('/'),
  ['src', 'coordinator', 'equipment', 'contract.ts'].join('/'),
  ['src', 'coordinator', 'composition', 'recovery-registry.ts'].join('/'),
] as const;
const RETIRED_RUNTIME_ALIASES = ['RuntimeTime', 'RuntimeStorage', 'RuntimeProcess', 'RuntimeIds', 'RuntimeEnv'];
const RETIRED_RECORD_IDENTIFIERS = new Set([
  'Persisted' + 'StatusRecord',
  'Persisted' + 'LaunchRecord',
  'Persisted' + 'RuntimeRecord',
  'Persisted' + 'ExitRecord',
  'Persisted' + 'ProgressRecord',
  'Workflow' + 'Checkpoint',
  'Provider' + 'Result',
  'Provider' + 'ProgressEvent',
  'Terminal' + 'Result',
  'Session' + 'ContinuityPatch',
]);
const RETIRED_IDENTIFIER_PREFIX = ['Le', 'gacy'].join('');
const RETIRED_PREFIX_IDENTIFIER_RE = new RegExp(`^${RETIRED_IDENTIFIER_PREFIX}[A-Za-z0-9_]*$`);
const RETIRED_BOUNDARY_HELPERS = new Set([
  `describe${RETIRED_IDENTIFIER_PREFIX}CoralFault`,
  `${RETIRED_IDENTIFIER_PREFIX.toLowerCase()}WrapperCrashedFault`,
  `materialize${RETIRED_IDENTIFIER_PREFIX}TerminalOutcome`,
  `plan${RETIRED_IDENTIFIER_PREFIX}TerminalOutcome`,
  'Recovery' + 'FaultCompat',
]);
const PROVIDERS_ROOT = 'src/providers';
const SESSIONS_SHELL_ROOT = 'src/sessions/shell';
const STORE_QUERIES_ROOT = 'src/store/queries';
const WORKFLOW_PROVIDER_ALLOWLIST_TARGET = 'src/providers/catalog.ts';
const NEEDLE_BACKEND_TARGET = 'src/kb/search/needle-backend.ts';
const JOBS_TERMINAL_MATERIALIZER = 'src/jobs/terminal-materializer.ts';

const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const PRODUCTION_SOURCE_FILES = PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath));
const PRODUCTION_FILE_INDEX = createProductionFileIndex(REPO_ROOT, PRODUCTION_FILE_PATHS);
const PARSED_IMPORT_EDGES = PRODUCTION_FILE_PATHS.flatMap((filePath) =>
  parseSourceImportEdges(REPO_ROOT, filePath, PRODUCTION_FILE_INDEX),
);
const PARSED_IMPORT_EDGES_BY_SOURCE = new Map<string, ParsedImportEdge[]>();

for (const edge of PARSED_IMPORT_EDGES) {
  const edgesForSource = PARSED_IMPORT_EDGES_BY_SOURCE.get(edge.source) ?? [];
  edgesForSource.push(edge);
  PARSED_IMPORT_EDGES_BY_SOURCE.set(edge.source, edgesForSource);
}

type BoundaryViolation = {
  source: string;
  specifier: string;
  target: string;
  via: ParsedImportEdge['via'];
  ruleName: string;
  remediationHint: string;
};

function isWithinPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function collectViolations(
  sourceRoot: string,
  ruleName: string,
  remediationHint: string,
  isForbiddenTarget: (target: string) => boolean,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const sourceFile of PRODUCTION_SOURCE_FILES) {
    if (!isWithinPath(sourceFile, sourceRoot)) {
      continue;
    }

    for (const edge of PARSED_IMPORT_EDGES_BY_SOURCE.get(sourceFile) ?? []) {
      if (!isForbiddenTarget(edge.target)) {
        continue;
      }

      violations.push({
        source: edge.source,
        specifier: edge.specifier,
        target: edge.target,
        via: edge.via,
        ruleName,
        remediationHint,
      });
    }
  }

  return violations.sort((left, right) => {
    if (left.source !== right.source) {
      return left.source.localeCompare(right.source);
    }

    if (left.specifier !== right.specifier) {
      return left.specifier.localeCompare(right.specifier);
    }

    if (left.target !== right.target) {
      return left.target.localeCompare(right.target);
    }

    return left.via.localeCompare(right.via);
  });
}

function assertNoViolations(violations: BoundaryViolation[]): void {
  if (violations.length === 0) {
    return;
  }

  expect.fail(
    violations
      .map((violation) =>
        [
          `Forbidden import: ${violation.source} imports ${violation.specifier} via ${violation.via}.`,
          `Rule: ${violation.ruleName}.`,
          `Resolved target: ${violation.target}.`,
          `Remediation: ${violation.remediationHint}.`,
        ].join('\n'),
      )
      .join('\n\n'),
  );
}

function collectRuntimeDeclarationsInTypesFiles(): string[] {
  const runtimeDeclarationPatterns: Array<[RegExp, string]> = [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m, 'function declaration'],
    [/^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|\w+)\s*=>)/m, 'function-valued const'],
    [/^\s*export\s+(?:class|enum)\s+\w+\b/m, 'runtime export'],
  ];

  return PRODUCTION_SOURCE_FILES.flatMap((filePath) => {
    if (!filePath.endsWith('/types.ts')) {
      return [];
    }

    const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
    return runtimeDeclarationPatterns
      .filter(([pattern]) => pattern.test(source))
      .map(([, label]) => `${filePath}: ${label}`);
  });
}

function listFilesRecursive(root: string, predicate: (filePath: string) => boolean): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filePath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(filePath, predicate);
    }

    return predicate(filePath) ? [filePath] : [];
  });
}

function collectTestQuarantineResidue(): string[] {
  const marker = ['@', 'fla', 'ky'].join('');
  const retryConfig = /\b(?:describe|it|test)\s*\([^)]*,\s*\{\s*retry\s*:/s;
  const scannedFiles = [
    ...listFilesRecursive(resolve(REPO_ROOT, 'tests/unit'), (filePath) => filePath.endsWith('.test.ts')),
    ...listFilesRecursive(resolve(REPO_ROOT, 'tests/invariants'), (filePath) => filePath.endsWith('.test.ts')),
    resolve(REPO_ROOT, 'scripts/test.mjs'),
  ];

  return scannedFiles.flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    const violations = [];
    if (source.includes(marker)) {
      violations.push('quarantine marker');
    }
    if (retryConfig.test(source)) {
      violations.push('Vitest retry option');
    }

    if (violations.length === 0) {
      return [];
    }

    return `${toCanonicalSrcPath(REPO_ROOT, filePath)}: ${violations.join(', ')}`;
  });
}

function scanRetiredIdentifierResidue(filePath: string): string[] {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isIdentifier(node)
      && (
        RETIRED_RECORD_IDENTIFIERS.has(node.text)
        || RETIRED_PREFIX_IDENTIFIER_RE.test(node.text)
        || RETIRED_BOUNDARY_HELPERS.has(node.text)
        || node.text === 'KbSubsystem'
      )
    ) {
      matches.add(node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...matches].sort();
}

function collectRetiredIdentifierResidue(): string[] {
  return PRODUCTION_FILE_PATHS.flatMap((filePath) => {
    const matches = scanRetiredIdentifierResidue(filePath);
    if (matches.length === 0) {
      return [];
    }

    return `${toCanonicalSrcPath(REPO_ROOT, filePath)}: ${matches.join(', ')}`;
  });
}

function collectRetiredRuntimeAliasResidue(): string[] {
  const portsPath = resolve(REPO_ROOT, 'src/runtime/ports.ts');
  if (!existsSync(portsPath)) {
    return [];
  }

  const source = readFileSync(portsPath, 'utf-8');
  return RETIRED_RUNTIME_ALIASES.filter((alias) =>
    new RegExp(`\\bexport\\s+type\\s+${alias}\\s*=`).test(source),
  );
}

function collectProductionStringResidue(tokens: readonly string[]): string[] {
  return PRODUCTION_FILE_PATHS.flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf-8');
    const matches = tokens.filter((token) => source.includes(token));
    if (matches.length === 0) {
      return [];
    }

    return `${toCanonicalSrcPath(REPO_ROOT, filePath)}: ${matches.join(', ')}`;
  });
}

function collectRawTerminalRecordedWriters(): string[] {
  return PRODUCTION_FILE_PATHS.flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf-8');
    if (!/type:\s*['"]job\.terminal\.recorded['"]/u.test(source)) {
      return [];
    }

    return [toCanonicalSrcPath(REPO_ROOT, filePath)];
  }).sort();
}

function collectLaunchPoolDefinitions(): string[] {
  return PRODUCTION_FILE_PATHS.flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf-8');
    if (!/export\s+type\s+LaunchPool\s*=/u.test(source)) {
      return [];
    }

    return [toCanonicalSrcPath(REPO_ROOT, filePath)];
  }).sort();
}

function collectDomainAmbientRuntimeAccess(): string[] {
  const scopedRoots = ['src/providers', 'src/workflow', 'src/kb', 'src/discuss'];
  const allowed = new Set([
    'src/kb/env.ts',
    'src/discuss/transcript.ts',
  ]);
  const ambientPattern =
    /\bDate\.now\s*\(|\bnew Date\s*\(|\bprocess\.env\b|\bMath\.random\s*\(|\bnow(?:Date|IsoString)\s*\(\s*\)/u;

  return PRODUCTION_SOURCE_FILES.filter((filePath) => {
    if (!scopedRoots.some((root) => isWithinPath(filePath, root)) || allowed.has(filePath)) {
      return false;
    }

    return ambientPattern.test(readFileSync(resolve(REPO_ROOT, filePath), 'utf8'));
  }).sort();
}

describe('architecture boundary guard', () => {
  it('workflow/ may only import from providers/catalog (allowlist of exactly one path)', () => {
    // Established by e34d8d8.
    const violations = collectViolations(
      WORKFLOW_ROOT,
      'workflow/ may only import from providers/catalog (allowlist of exactly one path)',
      'depend on src/providers/catalog.ts instead.',
      (target) => isWithinPath(target, PROVIDERS_ROOT) && target !== WORKFLOW_PROVIDER_ALLOWLIST_TARGET,
    );

    assertNoViolations(violations);
  });
  it('jobs/ may not import coordinator/ implementation modules', () => {
    const violations = collectViolations(
      JOBS_ROOT,
      'jobs/ must stay coordinator-free',
      'move the shared contract into jobs/, store/, runtime/, or another lower-level owner instead.',
      (target) => isWithinPath(target, COORDINATOR_ROOT),
    );

    assertNoViolations(violations);
  });
  it('jobs/reconcile stays session-implementation free', () => {
    const violations = collectViolations(
      JOBS_RECONCILE_ROOT,
      'jobs/reconcile plans recovery but coordinator owns session execution',
      'pass minimal session facts into the planner and keep SessionManager/SessionLookup usage under coordinator.',
      (target) =>
        isWithinPath(target, SESSIONS_SHELL_ROOT) ||
        target === 'src/sessions/lookup.ts' ||
        target === 'src/sessions/entry.ts',
    );

    assertNoViolations(violations);
  });
  it('jobs/reconcile does not import jobs shell modules', () => {
    const violations = collectViolations(
      JOBS_RECONCILE_ROOT,
      'jobs/reconcile owns recovery planning/effects without depending on jobs shell I/O',
      'move shared job materialization contracts under jobs/ instead of jobs/shell/.',
      (target) => isWithinPath(target, JOBS_SHELL_ROOT),
    );

    assertNoViolations(violations);
  });
  it('coordinator services depend on domain ports, not domain shell implementations', () => {
    const violations = collectViolations(
      COORDINATOR_SERVICES_ROOT,
      'coordinator/services consumes domain ports/contracts, not shell implementations',
      'move the service dependency to a domain-owned contract or inject the shell implementation from the composition root.',
      (target) =>
        isWithinPath(target, JOBS_SHELL_ROOT) ||
        isWithinPath(target, SESSIONS_SHELL_ROOT) ||
        target.startsWith('src/discuss/shell/'),
    );

    assertNoViolations(violations);
  });
  it('job terminal materializer remains a pure domain translator, not a god module', () => {
    const violations = collectViolations(
      JOBS_TERMINAL_MATERIALIZER,
      'jobs/terminal-materializer may only translate domain failures into job outcomes',
      'keep I/O, runtime access, shell orchestration, and coordinator policy outside terminal-materializer.',
      (target) =>
        isWithinPath(target, COORDINATOR_ROOT) ||
        isWithinPath(target, JOBS_SHELL_ROOT) ||
        isWithinPath(target, SESSIONS_SHELL_ROOT) ||
        isWithinPath(target, RUNTIME_ROOT),
    );
    const source = readFileSync(resolve(REPO_ROOT, JOBS_TERMINAL_MATERIALIZER), 'utf8');
    const forbiddenRuntimeTokens = [
      '.appendEvent(',
      '.appendTerminal(',
      '.readStatus(',
      '.loadJobProjectionDetail(',
      '.getDb(',
      '.readLaunchProjection(',
      '.appendLaunchRequested(',
    ].filter((token) => source.includes(token));

    assertNoViolations(violations);
    expect(forbiddenRuntimeTokens).toEqual([]);
  });
  it('raw job.terminal.recorded writes stay owned by the job store', () => {
    expect(collectRawTerminalRecordedWriters()).toEqual(['src/jobs/job-store.ts']);
  });
  it('launch/admission vocabulary has a single jobs-owned type authority', () => {
    expect(collectLaunchPoolDefinitions()).toEqual(['src/jobs/launch.ts']);

    const coordinatorContracts = readFileSync(resolve(REPO_ROOT, 'src/coordinator/contracts.ts'), 'utf8');
    expect(coordinatorContracts).not.toMatch(/ExecutionLaunch|ExecutionAdmission|ExecutionQueuedHandle/u);
    expect(coordinatorContracts).not.toContain('interface RecoveryCapableService');
  });
  it('discuss root recovery contract stays shell-free', () => {
    const recoveryContractPath = 'src/discuss/recovery-contract.ts';
    const edges = PARSED_IMPORT_EDGES_BY_SOURCE.get(recoveryContractPath) ?? [];
    expect(edges.map((edge) => edge.target).filter((target) => isWithinPath(target, 'src/discuss/shell'))).toEqual([]);

    const source = readFileSync(resolve(REPO_ROOT, recoveryContractPath), 'utf8');
    expect(source).not.toContain('DiscussContext');
    expect(source).not.toContain('RecoveredDiscussResume');
  });
  it('domain/provider modules receive time env and randomness through ports', () => {
    expect(collectDomainAmbientRuntimeAccess()).toEqual([]);
  });
  it('kb/ may not import coordinator/ implementation modules', () => {
    const violations = collectViolations(
      KB_ROOT,
      'kb/ must stay coordinator-free',
      'move the shared contract into kb/, store/, runtime/, or another lower-level owner instead.',
      (target) => isWithinPath(target, COORDINATOR_ROOT),
    );

    assertNoViolations(violations);
  });
  it('store query modules may not import domain shell modules', () => {
    const violations = collectViolations(
      STORE_QUERIES_ROOT,
      'store/queries must read Journal projections, not domain shells',
      'move shell reads behind projection tables or a store-owned query helper.',
      (target) => target.includes('/shell/'),
    );

    assertNoViolations(violations);
  });
  it('needle equipment backend is loaded only through lifecycle dynamic import', () => {
    expect(PARSED_IMPORT_EDGES.filter((edge) => edge.target === NEEDLE_BACKEND_TARGET)).toEqual([
      {
        source: 'src/coordinator/equipment/lifecycle.ts',
        specifier: '../../kb/search/needle-backend.js',
        target: NEEDLE_BACKEND_TARGET,
        via: 'DynamicImport',
        runtime: true,
        typeOnly: false,
      },
    ]);
  });
  it('providers may not import jobs shell modules', () => {
    const violations = collectViolations(
      PROVIDERS_ROOT,
      'providers must not depend on jobs/shell ownership',
      'depend on provider-owned ports or lower-level job contracts outside jobs/shell.',
      (target) => isWithinPath(target, JOBS_SHELL_ROOT),
    );

    assertNoViolations(violations);
  });
  it('session continuity mutation contracts stay under the session owner', () => {
    const providerShimExists =
      PRODUCTION_SOURCE_FILES.includes(RETIRED_PROVIDERS_CONTINUITY_MUTATION) ||
      existsSync(resolve(REPO_ROOT, RETIRED_PROVIDERS_CONTINUITY_MUTATION));
    const violations = collectViolations(
      SESSIONS_SHELL_ROOT,
      'sessions/shell must not import provider-owned continuity mutation types',
      'keep session continuity mutation contracts under src/sessions.',
      (target) => target === RETIRED_PROVIDERS_CONTINUITY_MUTATION,
    );

    expect(providerShimExists).toBe(false);
    assertNoViolations(violations);
  });
  it('clean-slate rewrite residue must stay out of production sources', () => {
    expect(collectProductionStringResidue([
      RETIRED_STATUS_SCHEMA_FAULT,
      RETIRED_TEXT_ARTIFACT_LOCK_METHOD,
    ])).toEqual([]);
  });
  it('kb corpus repair does not construct real runtime ports', () => {
    const violations = PARSED_IMPORT_EDGES.filter(
      (edge) => isWithinPath(edge.source, 'src/kb/corpus/repair') && edge.target === 'src/runtime/real.ts',
    );
    expect(violations.map((edge) => `${edge.source} -> ${edge.target}`)).toEqual([]);
  });
  it('the removed src client tree must remain deleted', () => {
    const clientFiles = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, CLIENT_ROOT));
    expect(clientFiles).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, CLIENT_ROOT))).toBe(false);
  });
  it('the removed src skills tree must remain deleted', () => {
    const skillsFiles = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, SKILLS_ROOT));
    expect(skillsFiles).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, SKILLS_ROOT))).toBe(false);
  });
  it('the removed src shared tree must remain deleted', () => {
    const sharedFiles = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, SHARED_ROOT));
    expect(sharedFiles).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, SHARED_ROOT))).toBe(false);
  });
  it('the retired pre-rewrite runtime boundary stays absent', () => {
    const executionFiles = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, EXECUTION_ROOT));
    expect(executionFiles).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, EXECUTION_ROOT))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_PRIVATE_STATE_ROOT))).toBe(false);
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_RUNTIME_MODULE);
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_RUNTIME_PORTS);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_RUNTIME_MODULE))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_RUNTIME_PORTS))).toBe(false);
    expect(collectRetiredRuntimeAliasResidue()).toEqual([]);
    expect(collectRetiredIdentifierResidue()).toEqual([]);
  });
  it('the debug-only simulation tool must stay out of src', () => {
    const simulationFiles = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, SIMULATION_ROOT));
    expect(simulationFiles).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, SIMULATION_ROOT))).toBe(false);
  });
  it('the debug-only simulation scenario corpus must live with the simulation tool', () => {
    expect(existsSync(resolve(REPO_ROOT, ROOT_SCENARIOS_ROOT))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, DEBUG_SIMULATION_SCENARIOS_ROOT))).toBe(true);
  });
  it('test code and test support must stay out of src', () => {
    const srcTestArtifacts = PRODUCTION_SOURCE_FILES.filter(
      (file) => file.endsWith('.test.ts') || file.includes('/__tests__/') || file.startsWith('src/testing/'),
    );
    expect(srcTestArtifacts).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, 'src/testing'))).toBe(false);
  });
  it('the retired kb api shim must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_KB_API);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_KB_API))).toBe(false);
  });
  it('the retired jobs views module must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_JOBS_VIEWS);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_JOBS_VIEWS))).toBe(false);
  });
  it('the retired providers api shim must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_PROVIDERS_API);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_PROVIDERS_API))).toBe(false);
  });
  it('the retired transport http-client module must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_HTTP_CLIENT);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_HTTP_CLIENT))).toBe(false);
  });
  it('the retired jobs barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_JOBS_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_JOBS_INDEX))).toBe(false);
  });
  it('the retired sessions barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_SESSIONS_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_SESSIONS_INDEX))).toBe(false);
  });
  it('the retired transport http barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_TRANSPORT_HTTP_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_TRANSPORT_HTTP_INDEX))).toBe(false);
  });
  it('the retired coordinator barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_COORDINATOR_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_COORDINATOR_INDEX))).toBe(false);
  });
  it('the retired workflow barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_WORKFLOW_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_WORKFLOW_INDEX))).toBe(false);
  });
  it('the retired runtime barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_RUNTIME_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_RUNTIME_INDEX))).toBe(false);
  });
  it('the retired discuss api seam must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_DISCUSS_API);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_DISCUSS_API))).toBe(false);
  });
  it('the retired discuss views module must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_DISCUSS_VIEWS);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_DISCUSS_VIEWS))).toBe(false);
  });
  it('the retired discuss time alias must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_DISCUSS_TIME_UTIL);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_DISCUSS_TIME_UTIL))).toBe(false);
  });
  it('the retired coordinator log alias must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_COORDINATOR_LOG);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_COORDINATOR_LOG))).toBe(false);
  });
  it('the retired jobs exports path alias must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_EXPORTS_PATHS);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_EXPORTS_PATHS))).toBe(false);
  });
  it('the retired kb corpus path alias must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_CORPUS_PATHS);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_CORPUS_PATHS))).toBe(false);
  });
  it('the retired infra index barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_INFRA_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_INFRA_INDEX))).toBe(false);
  });
  it('the retired bridge-manifest helper must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_BRIDGE_MANIFEST);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_BRIDGE_MANIFEST))).toBe(false);
  });
  it('the retired simulation index barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_SIMULATION_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_SIMULATION_INDEX))).toBe(false);
  });
  it('the retired simulation core index barrel must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_SIMULATION_CORE_INDEX);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_SIMULATION_CORE_INDEX))).toBe(false);
  });
  it('the retired simulation world owner must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_SIMULATION_WORLD);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_SIMULATION_WORLD))).toBe(false);
  });
  it('the retired simulation schema filename must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_SIMULATION_SCHEMA);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_SIMULATION_SCHEMA))).toBe(false);
  });
  it('the retired simulation normalize filename must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_SIMULATION_NORMALIZE);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_SIMULATION_NORMALIZE))).toBe(false);
  });
  it('the retired request-context owners must remain deleted', () => {
    for (const retiredPath of [
      RETIRED_INFRA_REQUEST_CONTEXT,
      RETIRED_TRANSPORT_REQUEST_CONTEXT,
    ]) {
      expect(PRODUCTION_SOURCE_FILES).not.toContain(retiredPath);
      expect(existsSync(resolve(REPO_ROOT, retiredPath))).toBe(false);
    }
  });
  it('the retired fallback helper filenames must remain deleted', () => {
    for (const retiredPath of [
      RETIRED_JOB_HELPERS,
      RETIRED_CURATE_SHARED,
      RETIRED_CURATE_STATE_SHARED,
      RETIRED_CLAUDE_SHARED_UTILS,
      RETIRED_STRATEGY_SHARED,
      RETIRED_WORKFLOW_INTERNAL_SHARED,
      RETIRED_DISCUSS_READ_HELPERS,
      RETIRED_DISCUSS_FLOW_SHARED,
      RETIRED_DISCUSS_STATE_HELPERS,
      RETIRED_HTTP_BACKEND_HELPERS,
      RETIRED_KB_MUTATION_HELPERS,
      RETIRED_COMMAND_HELPERS,
      RETIRED_COORDINATOR_EXECUTION_SHARED,
      RETIRED_RUNTIME_FLAVOR,
      RETIRED_SESSIONS_API,
      RETIRED_HTTP_CONTRACTS,
      RETIRED_HTTP_WAIT_STREAM,
      RETIRED_HTTP_TOOL_RESPONSE,
      RETIRED_STORE_KB_QUERIES,
      RETIRED_STORE_JOB_QUERIES,
      RETIRED_STORE_DISCUSS_QUERIES,
      RETIRED_STORE_SESSION_QUERIES,
      RETIRED_STORE_WORKFLOW_QUERIES,
      RETIRED_STORE_CORAL_STORE,
      RETIRED_STORE_READ_CONTEXT,
      RETIRED_STORE_PATHS,
      RETIRED_STORE_CAUSE_REF,
      RETIRED_STORE_CORPUS_STATE,
      RETIRED_STORE_SCHEMA_SQL,
      RETIRED_STORE_MIGRATIONS_MODULE,
      RETIRED_STORE_MIGRATIONS_DIR,
      RETIRED_STORE_SCHEMAS_MODULE,
      RETIRED_SESSION_JSON_READER,
      RETIRED_JOBS_SHELL_FAULT_MATERIALIZER,
      RETIRED_JOBS_SHELL_CONTRACTS,
      RETIRED_JOBS_SHELL_AGENT_RESOLUTION,
      RETIRED_SESSIONS_SHELL_RESOLVE,
      RETIRED_DISCUSS_RECONCILE,
      RETIRED_TRANSPORT_SHARED_CONTEXT,
      RETIRED_COORDINATOR_CALLER_CONTEXT,
      RETIRED_STORE_CORPUS_CONSUMER,
      RETIRED_KB_CORPUS_REPAIR_TYPES,
    ]) {
      expect(PRODUCTION_SOURCE_FILES).not.toContain(retiredPath);
      expect(existsSync(resolve(REPO_ROOT, retiredPath))).toBe(false);
    }
  });
  it('production types.ts files remain declaration-only', () => {
    expect(collectRuntimeDeclarationsInTypesFiles()).toEqual([]);
  });
  it('unit and invariant tests do not carry quarantine residue', () => {
    expect(collectTestQuarantineResidue()).toEqual([]);
  });
  it('store schema baseline no longer contains projection_kb residue', () => {
    const initialSchema = readFileSync(resolve(REPO_ROOT, 'src/store/schemas/001_initial.sql'), 'utf8');

    expect(initialSchema).not.toContain('projection_kb');
  });
  it('public wait contract uses only global journal seq cursors', () => {
    const waitContract = readFileSync(resolve(REPO_ROOT, 'src/jobs/wait.ts'), 'utf8');
    const waitShell = readFileSync(resolve(REPO_ROOT, 'src/jobs/shell/wait.ts'), 'utf8');
    const waitEventSchema = readFileSync(resolve(REPO_ROOT, 'src/jobs/wait-stream-event.ts'), 'utf8');
    const jobRecords = readFileSync(resolve(REPO_ROOT, 'src/jobs/records.ts'), 'utf8');
    const jobStore = readFileSync(resolve(REPO_ROOT, 'src/jobs/job-store.ts'), 'utf8');
    const jobStoreContract = readFileSync(resolve(REPO_ROOT, 'src/jobs/progress-store-contract.ts'), 'utf8');
    const jobQueries = readFileSync(resolve(REPO_ROOT, 'src/jobs/read/queries.ts'), 'utf8');
    const simulationWorld = readFileSync(resolve(REPO_ROOT, 'tools/simulation/adversarial.ts'), 'utf8');

    expect(waitContract).toContain('afterSeq: number');
    expect(waitContract).toContain('seq: number');
    expect(waitContract).not.toContain('jobs: Record');
    expect(waitContract).not.toContain('eventId');
    expect(waitShell).not.toContain('JOURNAL_WAIT_POLL_MS');
    expect(waitShell).not.toContain('poll-journal');
    expect(waitShell).not.toContain('POLL_JOURNAL');
    expect(waitEventSchema).toContain('seq: z.number().int().nonnegative()');
    expect(waitEventSchema).not.toContain('eventId');
    expect(jobRecords).not.toContain('eventId');
    expect(jobStore).not.toContain('ReplayCursor');
    expect(jobStore).not.toContain('replayFrom');
    expect(jobStore).not.toContain('eventId');
    expect(jobStoreContract).not.toContain('ReplayCursor');
    expect(jobStoreContract).not.toContain('replayFrom');
    expect(jobQueries).not.toContain('per_job_index');
    expect(jobQueries).not.toContain('eventId');
    expect(simulationWorld).not.toContain('ReplayCursor');
    expect(simulationWorld).not.toContain('createReplayCursor');
    expect(simulationWorld).not.toContain('replayFrom');
  });
  it('retired install-scoped path helpers stay out of infra/paths.ts', () => {
    const pathsSource = readFileSync(resolve(REPO_ROOT, 'src/infra/paths.ts'), 'utf8');

    expect(pathsSource).not.toContain('installationDirForNamespace');
    expect(pathsSource).not.toContain('installationDir(');
    expect(pathsSource).not.toContain('backendInfoPath(');
    expect(pathsSource).not.toContain('backendLockPath(');
    expect(pathsSource).not.toContain('sessionBase(');
    expect(pathsSource).not.toContain('.claude');
  });
  it('production homedir imports remain confined to path authority modules', () => {
    const allowed = new Set([
      'src/infra/backend-discovery.ts',
      'src/infra/paths.ts',
      'src/infra/plugin-registry.ts',
      'src/runtime/real.ts',
    ]);
    const offenders = PRODUCTION_SOURCE_FILES.filter((filePath) => {
      if (allowed.has(filePath)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
      return /import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from ['"]node:os['"]/u.test(source);
    });

    expect(offenders).toEqual([]);
  });
  it('production keeps store/index.ts as the only remaining index barrel', () => {
    const liveIndexes = PRODUCTION_SOURCE_FILES.filter((filePath) => filePath.endsWith('/index.ts'));
    expect(liveIndexes).toEqual(['src/store/index.ts']);
  });
  it('production keeps helper-style filenames out of src/', () => {
    const helperLikeFiles = PRODUCTION_SOURCE_FILES.filter(
      (filePath) =>
        filePath.endsWith('/helper.ts')
        || filePath.endsWith('/helpers.ts')
        || filePath.endsWith('/shared.ts')
        || filePath.endsWith('/shared-utils.ts'),
    );
    expect(helperLikeFiles).toEqual([]);
  });
  it('the removed coordinator shim files must remain deleted', () => {
    for (const shimPath of RETIRED_COORDINATOR_SHIMS) {
      expect(PRODUCTION_SOURCE_FILES).not.toContain(shimPath);
      expect(existsSync(resolve(REPO_ROOT, shimPath))).toBe(false);
    }
  });
});
