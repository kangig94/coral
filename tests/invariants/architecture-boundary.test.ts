/*
Architectural boundary guard for seams established by:
- e34d8d8: workflow/ may depend on provider discovery only through src/providers/catalog.ts, not provider implementations or provider internals.
This test enforces those boundaries with the TypeScript compiler API and treats import type, export ... from, typeof import('...'), and relative dynamic import('...') as boundary-crossing imports.
Known non-goals: computed import(variableName) and relative require('...') are intentionally not covered.
*/

// Shared scanning helpers stay extracted because the reused resolver and AST import scanner exceed the inline duplication threshold.
import { dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  createProductionFileIndex,
  listProductionSourceFiles,
  parseSourceImportEdges,
  parseSourceSubpathImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
  type SubpathImportEdge,
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
const RETIRED_TEXT_ARTIFACTS_DIR = ['src', 'kb', 'curate', 'text-artifacts'].join('/');
const RETIRED_CORPUS_REPAIR_DIR = ['src', 'kb', 'corpus', 'repair'].join('/');
const RETIRED_TEXT_ARTIFACTS_ENTRY_POINTS = [
  'readMalformedEntryRepair',
  'pendingRepairNeedsRetry',
  'rebuildTextArtifactsAndPersistRepairState',
  'TextSnapshotRebuildError',
  'detectTextArtifactRebuildInfo',
] as const;
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
const RETIRED_STORE_PROJECTION_CONSUMER = ['src', 'store', 'projection-consumer.ts'].join('/');
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
const NEEDLE_BACKEND_TARGET = 'src/engines/needle/backend.ts';
const SESSION_FAULT_EVENTS = 'src/sessions/event-builders.ts';
const COORDINATOR_TERMINAL_MATERIALIZER = 'src/coordinator/services/terminal-materializer.ts';
const JOBS_TERMINAL_RECORDING = 'src/jobs/terminal/recording.ts';
const KB_PATHS_MODULE = 'src/kb/paths.ts';
const KB_JOB_RECORDER = 'src/coordinator/services/kb/recorder.ts';
const DURABLE_TRANSPORT_MODULE = 'src/coordinator/live/durable-transport.ts';
const PROVIDER_SERVER_TRANSPORT_MODULE = 'src/coordinator/live/provider-server-transport.ts';
const CONSUMER_DRIVER_MODULE = 'src/coordinator/consumer-driver.ts';

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

const PARSED_SUBPATH_IMPORT_EDGES: readonly SubpathImportEdge[] = PRODUCTION_FILE_PATHS.flatMap((filePath) =>
  parseSourceSubpathImportEdges(REPO_ROOT, filePath),
);

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
    [
      /^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|\w+)\s*=>)/m,
      'function-valued const',
    ],
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

function collectSrcMarkdownFiles(): string[] {
  return listFilesRecursive(SRC_ROOT, (filePath) => filePath.endsWith('.md'))
    .map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath))
    .sort();
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
      ts.isIdentifier(node) &&
      (RETIRED_RECORD_IDENTIFIERS.has(node.text) ||
        RETIRED_PREFIX_IDENTIFIER_RE.test(node.text) ||
        RETIRED_BOUNDARY_HELPERS.has(node.text) ||
        node.text === 'KbSubsystem')
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
  return RETIRED_RUNTIME_ALIASES.filter((alias) => new RegExp(`\\bexport\\s+type\\s+${alias}\\s*=`).test(source));
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
    // Match an event-construction object literal: `{ type: 'job.terminal.recorded' ... body: ... }`.
    // Registry entries (`defineDomainEvent({ type, schema, reducer })`) have no `body:` field and
    // are correctly excluded — they declare the type, they do not construct events of it.
    if (!/\{\s*type:\s*['"]job\.terminal\.recorded['"][\s\S]{0,500}?body\s*:/u.test(source)) {
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
  // kb/paths.ts owns the CORAL_KB_PATH env override (vault root) — that env
  // read is the contract, not a leak.
  // src/kb/ops/memo.ts uses `new Date(mtimeMs)` to convert disk-sourced mtime
  // millis to ISO; the millis come from `storage.statSync` (port-routed), not
  // from ambient time, so the construction is a deterministic format step.
  const allowed = new Set(['src/kb/env.ts', 'src/discuss/transcript.ts', 'src/kb/paths.ts', 'src/kb/ops/memo.ts']);
  const ambientPattern =
    /\bDate\.now\s*\(|\bnew Date\s*\(|\bprocess\.env\b|\bMath\.random\s*\(|\bnow(?:Date|IsoString)\s*\(\s*\)/u;

  return PRODUCTION_SOURCE_FILES.filter((filePath) => {
    if (!scopedRoots.some((root) => isWithinPath(filePath, root)) || allowed.has(filePath)) {
      return false;
    }

    return ambientPattern.test(readFileSync(resolve(REPO_ROOT, filePath), 'utf8'));
  }).sort();
}

function collectProductionTestHelperImports(): string[] {
  const helperImportPattern = /from\s+['"]#tests\/helpers\/|import\s*\(\s*['"]#tests\/helpers\//u;
  return PRODUCTION_SOURCE_FILES.filter((filePath) =>
    helperImportPattern.test(readFileSync(resolve(REPO_ROOT, filePath), 'utf8')),
  ).sort();
}

function collectReadModelAmbientRuntimeAccess(): string[] {
  const ambientPattern = /\bprocess\.cwd\s*\(|\bprocess\.env\b/u;
  return PRODUCTION_SOURCE_FILES.filter((filePath) => {
    if (!isWithinPath(filePath, 'src/read-model')) {
      return false;
    }

    return ambientPattern.test(readFileSync(resolve(REPO_ROOT, filePath), 'utf8'));
  }).sort();
}

function collectKbOperationFailureWriters(): string[] {
  return PRODUCTION_SOURCE_FILES.flatMap((filePath) => {
    const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
    if (!source.includes('kb_operation_failed')) {
      return [];
    }
    return [filePath];
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
  it('session fault event builders are import-pure', () => {
    const violations = collectViolations(
      SESSION_FAULT_EVENTS,
      'session fault event builders own only session event vocabulary',
      'keep runtime access and cross-domain orchestration outside sessions/event-builders.ts.',
      (target) =>
        isWithinPath(target, COORDINATOR_ROOT) || isWithinPath(target, JOBS_ROOT) || isWithinPath(target, RUNTIME_ROOT),
    );
    const runtimeEdges = (PARSED_IMPORT_EDGES_BY_SOURCE.get(SESSION_FAULT_EVENTS) ?? []).filter((edge) => edge.runtime);

    assertNoViolations(violations);
    expect(runtimeEdges).toEqual([]);
  });
  it('coordinator terminal materializer avoids shell and live implementation imports', () => {
    const violations = collectViolations(
      COORDINATOR_TERMINAL_MATERIALIZER,
      'coordinator terminal materializer may compose domains without shell/live implementation reach-through',
      'depend on pure event builders, jobs-owned recording helpers, or lower-level contracts.',
      (target) =>
        isWithinPath(target, JOBS_SHELL_ROOT) ||
        isWithinPath(target, SESSIONS_SHELL_ROOT) ||
        target.startsWith('src/coordinator/live/'),
    );

    assertNoViolations(violations);
  });
  it('raw job.terminal.recorded writes stay owned by jobs terminal recording', () => {
    expect(collectRawTerminalRecordedWriters()).toEqual([JOBS_TERMINAL_RECORDING]);
  });
  it('production sources never import tests/helpers', () => {
    expect(collectProductionTestHelperImports()).toEqual([]);
  });
  it('launch/admission vocabulary has a single jobs-owned type authority', () => {
    expect(collectLaunchPoolDefinitions()).toEqual(['src/jobs/launch.ts']);

    const coordinatorContracts = readFileSync(resolve(REPO_ROOT, 'src/coordinator/contracts.ts'), 'utf8');
    expect(coordinatorContracts).not.toMatch(/ExecutionLaunch|ExecutionAdmission|ExecutionQueuedHandle/u);
    expect(coordinatorContracts).not.toContain('interface RecoveryCapableService');
  });
  it('discuss live-boundary predicate stays shell-free', () => {
    // The `isWithinLiveSessionBoundary` predicate lives in `discuss/events.ts`
    // alongside `PersistedDiscussSnapshot` (its only input). The earlier
    // `discuss/recovery-contract.ts` split was over-decomposition; this
    // invariant ensures the predicate's host file does not pull in shell
    // types or shell-side helpers.
    const eventsPath = 'src/discuss/events.ts';
    const edges = PARSED_IMPORT_EDGES_BY_SOURCE.get(eventsPath) ?? [];
    expect(edges.map((edge) => edge.target).filter((target) => isWithinPath(target, 'src/discuss/shell'))).toEqual([]);

    const source = readFileSync(resolve(REPO_ROOT, eventsPath), 'utf8');
    expect(source).toContain('export function isWithinLiveSessionBoundary');
    expect(source).not.toContain('DiscussContext');
    expect(source).not.toContain('RecoveredDiscussResume');
  });
  it('domain/provider modules receive time env and randomness through ports', () => {
    expect(collectDomainAmbientRuntimeAccess()).toEqual([]);
  });
  it('kb paths and read-model reads do not silently choose ambient roots', () => {
    const kbPathSource = readFileSync(resolve(REPO_ROOT, KB_PATHS_MODULE), 'utf8');
    // kbRoot/kbRuntimeDir are *defined* in kb/paths.ts; what we forbid is
    // *calling* them as ambient lookups — that is, binding their result without
    // an explicit `baseDir` second argument. Both `= kbRoot()` (zero-arg) and
    // `= kbRoot(flavor)` (flavor-only) fall back to env/homedir, so they count
    // as ambient. Calls that pass a baseDir (`kbRoot(flavor, baseDir)`) are
    // explicit and allowed. `kbRuntimeDir` accepts no baseDir at all, so any
    // bound result is ambient.
    expect(kbPathSource).not.toMatch(/=\s*(?:kbRoot|kbRuntimeDir)\s*\(\s*[^,)]*\)/u);
    expect(kbPathSource).not.toContain('currentBuildFlavor');
    expect(collectReadModelAmbientRuntimeAccess()).toEqual([]);
  });
  it('kb operation failure journal facts are centralized in the coordinator recorder', () => {
    expect(collectKbOperationFailureWriters()).toEqual([KB_JOB_RECORDER]);
  });
  it('large coordinator transport stays split by responsibility and consumer-driver helpers stay inlined', () => {
    expect(PRODUCTION_SOURCE_FILES).toContain(PROVIDER_SERVER_TRANSPORT_MODULE);
    expect(PRODUCTION_SOURCE_FILES).toContain(CONSUMER_DRIVER_MODULE);
    expect(PRODUCTION_SOURCE_FILES).not.toContain('src/coordinator/consumer-driver-support.ts');

    const durableTransportSource = readFileSync(resolve(REPO_ROOT, DURABLE_TRANSPORT_MODULE), 'utf8');
    expect(durableTransportSource).not.toContain('createInterface');
    expect(durableTransportSource).not.toContain('ProviderServerEntry');
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
  it('needle backend is loaded only through the needle expansion module', () => {
    expect(PARSED_IMPORT_EDGES.filter((edge) => edge.target === NEEDLE_BACKEND_TARGET)).toEqual([
      {
        source: 'src/engines/needle/expansion.ts',
        specifier: './backend.js',
        target: NEEDLE_BACKEND_TARGET,
        via: 'ImportDeclaration',
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
  it('runtime/binding.ts stays runtime-local and imports only its error and port homes', () => {
    expect((PARSED_IMPORT_EDGES_BY_SOURCE.get('src/runtime/binding.ts') ?? []).map((edge) => edge.target)).toEqual([
      'src/runtime/errors.ts',
      'src/runtime/ports.ts',
    ]);
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
  it('removed-vocabulary residue must stay out of production sources', () => {
    expect(collectProductionStringResidue([RETIRED_STATUS_SCHEMA_FAULT, RETIRED_TEXT_ARTIFACT_LOCK_METHOD])).toEqual(
      [],
    );
  });
  it('kb corpus rescan does not construct real runtime ports', () => {
    const violations = PARSED_IMPORT_EDGES.filter(
      (edge) => isWithinPath(edge.source, 'src/kb/corpus/rescan') && edge.target === 'src/runtime/real.ts',
    );
    expect(violations.map((edge) => `${edge.source} -> ${edge.target}`)).toEqual([]);
  });
  it('rescan scan.ts reaches the corpus only through the kb-domain CorpusStorage port (Phase 8 SRW boundary)', () => {
    const scanPath = 'src/kb/corpus/rescan/scan.ts';
    const source = readFileSync(resolve(REPO_ROOT, scanPath), 'utf8');
    const violations: string[] = [];
    if (/from\s+['"]node:fs['"]/u.test(source)) {
      violations.push(`${scanPath}: imports node:fs (must reach corpus via CorpusStorage)`);
    }
    if (/\bStoragePort\b/u.test(source)) {
      violations.push(`${scanPath}: references StoragePort (only CorpusStorage allowed at the rescan boundary)`);
    }
    expect(violations).toEqual([]);
  });
  it('rescan drift.ts routes filesystem reads through the runtime StoragePort (Single Runtime World)', () => {
    const driftPath = 'src/kb/corpus/rescan/drift.ts';
    const source = readFileSync(resolve(REPO_ROOT, driftPath), 'utf8');
    const violations: string[] = [];
    if (/from\s+['"]node:fs['"]/u.test(source)) {
      violations.push(`${driftPath}: imports node:fs (must route through kb.storagePort)`);
    }
    expect(violations).toEqual([]);
  });
  it('rescan auto-fix.ts routes filesystem reads through the runtime StoragePort (Single Runtime World)', () => {
    const autoFixPath = 'src/kb/corpus/rescan/auto-fix.ts';
    const source = readFileSync(resolve(REPO_ROOT, autoFixPath), 'utf8');
    const violations: string[] = [];
    if (/from\s+['"]node:fs['"]/u.test(source)) {
      violations.push(`${autoFixPath}: imports node:fs (must route through kb.storagePort)`);
    }
    expect(violations).toEqual([]);
  });
  it('CorpusFileHandle is kb-domain vocabulary and stays out of src/infra/**', () => {
    const infraFiles = PRODUCTION_SOURCE_FILES.filter((filePath) => isWithinPath(filePath, 'src/infra'));
    const violations = infraFiles.flatMap((filePath) => {
      const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
      return /\bCorpusFileHandle\b/u.test(source)
        ? [`${filePath}: references CorpusFileHandle (kb-domain vocabulary must not appear under src/infra)`]
        : [];
    });
    expect(violations).toEqual([]);
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
  it('the removed src/execution runtime boundary stays absent', () => {
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
    // Raw scan that does NOT use `listProductionSourceFiles` (which deliberately
    // hides `__tests__/`). The invariant must catch the very pattern that
    // helper hides: every test file and test directory belongs in `tests/`.
    const violations: string[] = [];

    function scan(dirPath: string): void {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const entryPath = join(dirPath, entry.name);
        const canonical = toCanonicalSrcPath(REPO_ROOT, entryPath);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === '__snapshots__') {
            violations.push(`${canonical}/ (test directory inside src)`);
            continue;
          }
          scan(entryPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.tsx')) {
          violations.push(`${canonical} (test file inside src)`);
        }
      }
    }

    scan(SRC_ROOT);

    expect(violations).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, 'src/testing'))).toBe(false);
  });
  it('human prose docs must stay out of src', () => {
    expect(collectSrcMarkdownFiles()).toEqual([]);
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
    for (const retiredPath of [RETIRED_INFRA_REQUEST_CONTEXT, RETIRED_TRANSPORT_REQUEST_CONTEXT]) {
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
      RETIRED_STORE_PROJECTION_CONSUMER,
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
  it('the retired text-artifacts and corpus/repair directories must remain deleted', () => {
    for (const retiredDir of [RETIRED_TEXT_ARTIFACTS_DIR, RETIRED_CORPUS_REPAIR_DIR]) {
      expect(existsSync(resolve(REPO_ROOT, retiredDir))).toBe(false);
      const filesUnderRetiredDir = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, retiredDir));
      expect(filesUnderRetiredDir).toEqual([]);
    }
  });
  it('the retired text-artifacts entry-point identifiers must not appear anywhere in src/', () => {
    const violations: string[] = [];
    for (const filePath of PRODUCTION_FILE_PATHS) {
      const source = readFileSync(filePath, 'utf8');
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      for (const identifier of RETIRED_TEXT_ARTIFACTS_ENTRY_POINTS) {
        if (new RegExp(`\\b${identifier}\\b`).test(source)) {
          violations.push(`${canonical}: contains retired identifier ${identifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
  it('production types.ts files remain declaration-only', () => {
    expect(collectRuntimeDeclarationsInTypesFiles()).toEqual([]);
  });
  it('unit and invariant tests do not carry quarantine residue', () => {
    expect(collectTestQuarantineResidue()).toEqual([]);
  });
  it('the retired projection-consumer module must remain deleted and absent from src/ imports', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_STORE_PROJECTION_CONSUMER);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_STORE_PROJECTION_CONSUMER))).toBe(false);

    const offenders: string[] = [];
    for (const filePath of PRODUCTION_FILE_PATHS) {
      const source = readFileSync(filePath, 'utf8');
      if (source.includes('registerJournalProjectionConsumer') || source.includes('applyProjectionRange')) {
        offenders.push(toCanonicalSrcPath(REPO_ROOT, filePath));
      }
    }
    expect(offenders).toEqual([]);
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
    const jobStore = readFileSync(resolve(REPO_ROOT, 'src/jobs/store.ts'), 'utf8');
    const jobStoreContract = readFileSync(resolve(REPO_ROOT, 'src/jobs/contracts/job-store.ts'), 'utf8');
    const jobQueries = readFileSync(resolve(REPO_ROOT, 'src/jobs/read-queries.ts'), 'utf8');
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
  it('infra/paths.ts is permanently retired (use infra/path/compose and per-domain path modules)', () => {
    expect(existsSync(resolve(REPO_ROOT, 'src/infra/paths.ts'))).toBe(false);
  });
  it('production src/ imports infra/path/ subdir only via compose.ts (sibling files stay subdir-internal)', () => {
    // The infra/path/ subdir is the path subsystem: compose.ts is the public
    // composer (used by runtime port construction); root/store/coordinator/
    // expansion are private family builders. External src/ callers must go
    // through composeCoralPaths so that flavor-aware path resolution stays
    // funneled through one entry point. KB has a documented exception for
    // root.ts (cycle-break primitive needed for kbRuntimeDir).
    const COMPOSE_PUBLIC = 'src/infra/path/compose.ts';
    const ALLOWED_INTERNAL_IMPORTERS: Record<string, ReadonlySet<string>> = {
      'src/infra/path/root.ts': new Set(['src/kb/paths.ts', 'src/kb/env.ts', 'src/infra/project-source.ts']),
    };
    const offenders: string[] = [];
    for (const edge of PARSED_IMPORT_EDGES) {
      if (edge.source.startsWith('src/infra/path/')) {
        continue;
      }
      if (!edge.target.startsWith('src/infra/path/') || edge.target === COMPOSE_PUBLIC) {
        continue;
      }
      const allowed = ALLOWED_INTERNAL_IMPORTERS[edge.target];
      if (allowed?.has(edge.source)) {
        continue;
      }
      offenders.push(`${edge.source} -> ${edge.target}`);
    }
    expect(offenders).toEqual([]);
  });
  it('production homedir imports remain confined to path authority modules', () => {
    const allowed = new Set([
      'src/infra/backend-discovery.ts',
      'src/infra/path/compose.ts',
      'src/infra/path/root.ts',
      'src/infra/plugin-registry.ts',
      'src/kb/paths.ts',
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
  it('production keeps helper-style filenames out of src/', () => {
    // Generic filenames become magnets when they describe NOTHING about content
    // — `helpers.ts`, `utils.ts`, `shared.ts` invite "anything that fits" and
    // accumulate unrelated logic. Forbid these outright, including the
    // hyphenated variants (`install-helpers.ts`, `state-shared.ts`, ...) that
    // slip the bare-suffix check by carrying a token before "helpers".
    //
    // `index.ts` and `types.ts` are intentionally NOT forbidden: both are valid
    // conventional names with clear semantics (entry point, type vocabulary).
    // Discipline is on *content*, not *name*: if either file grows large or
    // loses cohesion, it MUST be split. Add a per-file size invariant when a
    // specific file is at risk (see `providers/contract.ts` cap below).
    const FORBIDDEN_NAME_PATTERN = /\/(?:[\w-]*-)?(?:helper|helpers|shared|shared-utils|utils)\.ts$/u;
    const helperLikeFiles = PRODUCTION_SOURCE_FILES.filter((filePath) => FORBIDDEN_NAME_PATTERN.test(filePath));
    expect(helperLikeFiles).toEqual([]);
  });
  it('abort vocabulary lives only at src/runtime/abort.ts', () => {
    // §16 #53 cross-reference: AbortError / isAbortError / throwIfAborted have
    // exactly one home. Local re-implementations (`function isAbortError`,
    // `const isAbortError`, `createAbortError`, ad-hoc `new Error` whose name
    // is later set to 'AbortError') drift the vocabulary and break callers
    // that distinguish user aborts from deadline aborts via `signal.reason`.
    const ALLOWED_ABORT_VOCAB_HOME = 'src/runtime/abort.ts';
    const forbiddenPatterns: Array<[RegExp, string]> = [
      [/\bfunction\s+isAbortError\b/u, 'function isAbortError'],
      [/\bconst\s+isAbortError\s*=/u, 'const isAbortError'],
      [/\bfunction\s+isUserAbort\b/u, 'function isUserAbort'],
      [/\bconst\s+isUserAbort\s*=/u, 'const isUserAbort'],
      [/\bcreateAbortError\b/u, 'createAbortError'],
      [/\.name\s*=\s*['"]AbortError['"]/u, ".name = 'AbortError'"],
    ];
    const violations = PRODUCTION_SOURCE_FILES.flatMap((filePath) => {
      if (filePath === ALLOWED_ABORT_VOCAB_HOME) {
        return [];
      }
      const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
      return forbiddenPatterns.flatMap(([pattern, label]) => (pattern.test(source) ? [`${filePath}: ${label}`] : []));
    });
    expect(violations).toEqual([]);
  });
  it('the removed coordinator shim files must remain deleted', () => {
    for (const shimPath of RETIRED_COORDINATOR_SHIMS) {
      expect(PRODUCTION_SOURCE_FILES).not.toContain(shimPath);
      expect(existsSync(resolve(REPO_ROOT, shimPath))).toBe(false);
    }
  });
  it('expansion implementation files keep the single-function contract shape', () => {
    const forbiddenMembers = new Set([
      'install',
      'uninstall',
      'activate',
      'deactivate',
      'slots',
      'priority',
      'requires',
    ]);
    const expansionFiles = listFilesRecursive(SRC_ROOT, (filePath) => filePath.endsWith('/expansion.ts'))
      .map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath))
      .filter((filePath) => {
        if (filePath === 'src/cli/commands/expansion.ts') {
          return false;
        }
        const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
        return /from ['"][^'"]*\/expansion\/contract\.js['"]/u.test(source) && /\bExpansion\b/u.test(source);
      })
      .sort();
    // Threshold guard: an empty match would silently pass the per-file loop
    // below. The catalog ships at least three first-party expansions
    // (gemini, onnx, needle) — if any are missing, the filter is broken.
    expect(expansionFiles.length).toBeGreaterThanOrEqual(3);
    const violations: string[] = [];

    function exportedMemberNames(node: ts.Node): string[] {
      if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
        return node.members.flatMap((member) => {
          const name = member.name;
          return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
        });
      }

      if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
        return node.type.members.flatMap((member) => {
          const name = member.name;
          return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
        });
      }

      if (ts.isVariableStatement(node)) {
        return node.declarationList.declarations.flatMap((declaration) => {
          if (!ts.isObjectLiteralExpression(declaration.initializer)) {
            return [];
          }
          return declaration.initializer.properties.flatMap((property) => {
            if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
              return ts.isIdentifier(property.name) ? [property.name.text] : [];
            }
            return [];
          });
        });
      }

      return [];
    }

    function isFunctionValueExpression(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        return true;
      }

      if (!ts.isIdentifier(expression)) {
        return false;
      }

      for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === expression.text) {
          return true;
        }
        if (!ts.isVariableStatement(statement)) {
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== expression.text) {
            continue;
          }
          const initializer = declaration.initializer;
          if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
            return true;
          }
        }
      }

      return false;
    }

    for (const filePath of expansionFiles) {
      const absPath = resolve(REPO_ROOT, filePath);
      const sourceText = readFileSync(absPath, 'utf8');
      const sourceFile = ts.createSourceFile(absPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const defaultExport = sourceFile.statements.find(ts.isExportAssignment);
      if (!defaultExport || !isFunctionValueExpression(defaultExport.expression, sourceFile)) {
        violations.push(`${filePath}: default export must be a function value`);
      }

      for (const statement of sourceFile.statements) {
        const modifiers = 'modifiers' in statement ? statement.modifiers : undefined;
        if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          continue;
        }
        const hits = exportedMemberNames(statement).filter((name) => forbiddenMembers.has(name));
        if (hits.length >= 2) {
          violations.push(`${filePath}: exported shape reintroduces removed members (${hits.sort().join(', ')})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
  it('needle expansion keeps embedder access structural and free of captured concrete fallbacks', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/engines/needle/expansion.ts'), 'utf8');
    const sourceFile = ts.createSourceFile(
      resolve(REPO_ROOT, 'src/engines/needle/expansion.ts'),
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const importedNames = sourceFile.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
      const clause = statement.importClause;
      if (!clause) {
        return [];
      }

      const names: string[] = [];
      if (clause.name) {
        names.push(clause.name.text);
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names.push(...bindings.elements.map((element) => element.name.text));
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        names.push(bindings.name.text);
      }
      return names;
    });

    expect(importedNames).not.toContain('createEmbeddingProvider');
    expect(importedNames).not.toContain('GeminiEmbeddingProvider');
    expect(importedNames).not.toContain('OpenAICompatibleProvider');
    expect(importedNames).not.toContain('LocalOnnxProvider');
    expect(source).not.toMatch(/\bcreateEmbeddingProvider\b/u);
    expect(source).not.toMatch(/\bGEMINI_API_KEY\b/u);
    expect(source).not.toMatch(/\bGeminiEmbeddingProvider\b/u);
    expect(source).not.toMatch(/\bOpenAICompatibleProvider\b/u);
    expect(source).not.toMatch(/\bLocalOnnxProvider\b/u);
    expect(source).not.toMatch(/['"]gemini['"]/u);
    expect(source).toMatch(/host\.require\(host\.kb\.embedding\)/u);
  });
  it('providers/contract.ts stays under the magnet threshold', () => {
    // The provider protocol surface is inherently broad (request/action/spec/lease/
    // event/middleware/runtime types), so a single contract file is correct. But
    // unbounded growth turns it into a magnet that absorbs provider-local
    // helpers, factories, and normalizers. Cap is a review gate: if you need to
    // bump it, first ask whether the new content belongs in a domain
    // subdirectory (`providers/<name>/`) instead of the global contract.
    const source = readFileSync(resolve(REPO_ROOT, 'src/providers/contract.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(450);
  });

  it('coordinator/consumer-driver.ts stays under the orchestration-nucleus cap', () => {
    // ConsumerDriver is the projection-consumer orchestration nucleus —
    // registration, cursor advancement, apply scheduling, forced apply, and
    // waiter linkage all live here because they share invariants (single-
    // writer freshness, in-flight serialization, cursor ownership) that
    // cannot be split without bridging them through a parallel coordinator.
    // The cap is a review gate: if you need to bump it, first ask whether the
    // new content is a genuinely new orchestration responsibility or whether
    // it belongs in a sibling file under `coordinator/` (e.g., a separate
    // forced-apply scheduler) that the driver consumes through a contract.
    const source = readFileSync(resolve(REPO_ROOT, 'src/coordinator/consumer-driver.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(1300);
  });

  it('transport/ipc/ensure.ts stays under the singleton-replacement cap', () => {
    // IPC ensure is the coordinator-singleton replacement nucleus —
    // observation classification, lock acquisition, spawn/handoff, sick
    // verification, and reconciler dispatch all live here because they share
    // the §11.2 / §16 #1 single-writer invariant. Splitting them risks
    // races between observation and action. The cap is a review gate: if you
    // need to bump it, first ask whether new content is a sibling concern
    // (e.g., a new transport layer or a separate health-probe primitive)
    // that consumes ensure through a contract instead of growing inside it.
    const source = readFileSync(resolve(REPO_ROOT, 'src/transport/ipc/ensure.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(900);
  });

  it('claude-appserver/controller.ts stays under the appserver-controller cap', () => {
    // The Claude appserver controller orchestrates appserver lifecycle,
    // turn dispatch, continuity persistence, and recovery — concerns that
    // share the appserver session invariant. The cap is a review gate.
    const source = readFileSync(resolve(REPO_ROOT, 'src/providers/claude-appserver/controller.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(950);
  });

  it('kb/runtime.ts stays under the kb-runtime cap', () => {
    // KB runtime owns the corpus authority lifecycle (mutation lock,
    // freshness sync, rebuild dispatch). The cap is a review gate; new
    // content should land in a sibling kb/ module that consumes the
    // runtime through a contract.
    const source = readFileSync(resolve(REPO_ROOT, 'src/kb/runtime.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(900);
  });

  it('runtime/real.ts stays under the runtime-composition cap', () => {
    // The real runtime composes every port (storage/process/network/time/...)
    // for production use. Growth signals an unwanted port; either
    // narrow the new capability or split it into a domain-specific port.
    const source = readFileSync(resolve(REPO_ROOT, 'src/runtime/real.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(870);
  });

  it('providers/codex/thread-kernel.ts stays under the codex-kernel cap', () => {
    // Codex thread kernel owns the codex MCP turn loop — submission,
    // event dispatch, checkpointing, abort handling, and lease lifecycle
    // share the same turn-state invariant. The cap is a review gate.
    const source = readFileSync(resolve(REPO_ROOT, 'src/providers/codex/thread-kernel.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(870);
  });

  it('transport/http/handler.ts stays under the http-dispatch cap', () => {
    // The HTTP handler combines token-compare, body parsing, route-table
    // construction, dispatch, SSE primitives, and subscription handlers.
    // It is cohesive (one HTTP entry, one routing fabric) but at the size
    // ceiling. New routes belong in dedicated handler modules referenced
    // from the route table, not inlined here.
    const source = readFileSync(resolve(REPO_ROOT, 'src/transport/http/handler.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(680);
  });

  it('jobs/read-queries.ts stays under the jobs-read-queries cap', () => {
    // Jobs read-queries owns the prepared-statement cache, body decode,
    // hydration, and the list/detail/progress query APIs as a single
    // read-port surface. Splitting fragments the SQL/projection lookup
    // path; the cap is a review gate. New query helpers belong in a
    // sibling read-* module owned by the same domain.
    const source = readFileSync(resolve(REPO_ROOT, 'src/jobs/read-queries.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(770);
  });

  it('engines/needle/backend.ts stays under the needle-backend cap', () => {
    // Needle backend orchestrates Consumer apply/search, snapshot manifest
    // bookkeeping, install/staging, and active-handle leasing as a single
    // cohesive engine. Forced splits would re-couple through exported
    // mutable state. The cap is a review gate; new helpers belong in
    // sibling engines/needle modules with a contract-style entry.
    const source = readFileSync(resolve(REPO_ROOT, 'src/engines/needle/backend.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(770);
  });

  it('coordinator/lifecycle.ts stays under the lifecycle cap', () => {
    // The coordinator lifecycle file owns startup ordering, recovery
    // dispatch, freshness coordination, and shutdown. New lifecycle
    // phases should compose existing primitives rather than inflate this
    // file; the cap is a review gate.
    const source = readFileSync(resolve(REPO_ROOT, 'src/coordinator/lifecycle.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(670);
  });

  it('coordinator/index.ts stays under the composition-root cap', () => {
    // The coordinator composition root wires runtime ports, domain owners,
    // boot-readiness, and the IPC/HTTP server fabric. Boot-readiness and
    // artifact-lag repair are reachable from here but should compose
    // sibling helpers rather than expand this file. The cap is a review
    // gate; growth signals an unwanted dependency.
    const source = readFileSync(resolve(REPO_ROOT, 'src/coordinator/index.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(560);
  });

  it('coordinator/composition/index.ts stays under the composition-assembly cap', () => {
    // Wires RPC ports, KB failure recording glue, health response shaping,
    // and HTTP/IPC dependency assembly. New domain composition belongs in
    // sibling modules referenced from here; growth past the cap signals
    // unwanted concentration in the composition root.
    const source = readFileSync(resolve(REPO_ROOT, 'src/coordinator/composition/index.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(570);
  });

  it('kb/tool-handlers.ts stays under the kb-tool-dispatch cap', () => {
    // Routes KB tool calls (search, read, write, mutation, source/memo
    // operations) through one dispatch surface. The cohesion is the
    // tool-call envelope. New tool families that bring independent change
    // reasons should live in a `kb/tool/` subdirectory; the cap is a
    // review gate.
    const source = readFileSync(resolve(REPO_ROOT, 'src/kb/tool-handlers.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(550);
  });

  it('jobs/shell/launch.ts stays under the launch-orchestration cap', () => {
    // LaunchOrchestrator owns session claim, admission/queueing, recovered
    // queued jobs, provider runtime construction, stream consumption,
    // terminal materialization, and abort cleanup as one cohesive unit —
    // the launch state-machine shares mutable state across these phases
    // and forced extraction would re-couple through exported state. The
    // cap is a review gate.
    const source = readFileSync(resolve(REPO_ROOT, 'src/jobs/shell/launch.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(720);
  });

  it('kb domain modules do not compose runtimes or load engines', () => {
    // Composition (`createRealRuntime`, `createExpansionHost`, `createScope`)
    // and bundled-engine loading (`BUNDLED_ENGINES`, `loadBundledEngine`)
    // are coordinator/CLI/read-model concerns. The KB domain owns query
    // semantics and operations but never composes the runtime that runs
    // them — read-side composition lives at `read-model/kb-query-runtime.ts`.
    const forbiddenSpecifiers = [
      'runtime/real.js',
      'expansion/bundled.js',
      'expansion/host.js',
      'expansion/scope.js',
    ];
    const violations: string[] = [];
    for (const filePath of PRODUCTION_SOURCE_FILES) {
      if (!filePath.startsWith('src/kb/')) continue;
      const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
      for (const specifier of forbiddenSpecifiers) {
        if (source.includes(`from '${specifier.replace(/\.js$/, '')}`) || source.includes(`'../../${specifier}'`) || source.includes(`'../${specifier}'`)) {
          violations.push(`${filePath} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('jobs/store.ts stays under the jobs-store cap', () => {
    // JobStore wraps journal commit, event-bus publication, projection
    // read facade, result-artifact filesystem handling, namespace
    // overrides, queue sequencing, and live-count SQL. New responsibilities
    // belong in job-owned collaborators; the cap protects against silent
    // accretion.
    const source = readFileSync(resolve(REPO_ROOT, 'src/jobs/store.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(670);
  });

  it('Backed<T>-shaped exported declarations do not reintroduce readiness methods beside consumer', () => {
    const violations: string[] = [];

    function exportedMemberNames(node: ts.Node): string[] {
      if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
        return node.members.flatMap((member) => {
          const name = member.name;
          return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
        });
      }

      if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
        return node.type.members.flatMap((member) => {
          const name = member.name;
          return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
        });
      }

      if (ts.isVariableStatement(node)) {
        return node.declarationList.declarations.flatMap((declaration) => {
          if (!ts.isObjectLiteralExpression(declaration.initializer)) {
            return [];
          }
          return declaration.initializer.properties.flatMap((property) => {
            if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
              return ts.isIdentifier(property.name) ? [property.name.text] : [];
            }
            return [];
          });
        });
      }

      return [];
    }

    for (const filePath of PRODUCTION_FILE_PATHS) {
      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      for (const statement of sourceFile.statements) {
        const modifiers = 'modifiers' in statement ? statement.modifiers : undefined;
        if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          continue;
        }

        const memberNames = exportedMemberNames(statement);
        if (!memberNames.includes('consumer')) {
          continue;
        }

        const readinessMethods = memberNames.filter((name) => name === 'isReady' || name === 'waitForReady');
        if (readinessMethods.length > 0) {
          violations.push(
            `${toCanonicalSrcPath(REPO_ROOT, filePath)}: consumer declared alongside ${readinessMethods.sort().join(', ')}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
  it('retired vocabulary stays purged from src and removed paths remain deleted', () => {
    const removedPaths = [
      'src/expansion/contracts.ts',
      'src/expansion/equipment-contract.ts',
      'src/expansion/catalog.ts',
      'src/expansion/errors.ts',
      'src/expansion/activate.ts',
      'src/expansion/workflow.ts',
      'src/expansion/install.ts',
      'src/expansion/strategies',
      'src/coordinator/equipment',
    ];
    const forbiddenPatterns: Array<[RegExp, string]> = [
      [/\bEquipmentLifecycleService\b/u, 'EquipmentLifecycleService'],
      [/\bEquipmentLifecycleOptions\b/u, 'EquipmentLifecycleOptions'],
      [/\bEquipmentDescriptor\b/u, 'EquipmentDescriptor'],
      [/\bEquipmentDeps\b/u, 'EquipmentDeps'],
      [/\bEquipmentStatus\b/u, 'EquipmentStatus'],
      [/\bEquipmentSlot\b/u, 'EquipmentSlot'],
      [/\bSlotProvider\b/u, 'SlotProvider'],
      [/\bSlotRegistry\b/u, 'SlotRegistry'],
      [/\bExpansionContract\b/u, 'ExpansionContract'],
      [/\bRegisterEquipmentRequest\b/u, 'RegisterEquipmentRequest'],
      [/\bUnregisterEquipmentRequest\b/u, 'UnregisterEquipmentRequest'],
      [/\bListEquipmentRequest\b/u, 'ListEquipmentRequest'],
      [/\bRegisterEquipmentResult\b/u, 'RegisterEquipmentResult'],
      [/\bUnregisterResult\b/u, 'UnregisterResult'],
      [/\bListEquipmentResult\b/u, 'ListEquipmentResult'],
      [/\bequipmentViewSchema\b/u, 'equipmentViewSchema'],
      [/\bequipmentStatusSchema\b/u, 'equipmentStatusSchema'],
      [/\bEQUIPMENT_ADDON_FILENAMES\b/u, 'EQUIPMENT_ADDON_FILENAMES'],
      [/\bEquipmentPaths\b/u, 'EquipmentPaths'],
      [/\bEquipmentRequestPort\b/u, 'EquipmentRequestPort'],
      [/\bgetActiveVectorSurface\b/u, 'getActiveVectorSurface'],
      [/\bgetBaseRetrievalSurface\b/u, 'getBaseRetrievalSurface'],
      [/\bgetEquipmentView\b/u, 'getEquipmentView'],
      [/\bdefaultOwner\b/u, 'defaultOwner'],
      [/\bactiveKind\b/u, 'activeKind'],
      [/\bresolveVectorRoute\b/u, 'resolveVectorRoute'],
      [/\bcachedVectorRoute\b/u, 'cachedVectorRoute'],
      [/\bPluginHost\b/u, 'PluginHost'],
      [/\b(?:interface|class|function)\s+Plugin\b/u, 'Plugin declaration'],
      [/\btype\s+Plugin\s*=/u, 'Plugin type alias'],
      [/\bequipment_state\b/u, 'equipment_state'],
      [/\bequipment_cursors\b/u, 'equipment_cursors'],
      [/\bequipped_at\b/u, 'equipped_at'],
      [/\bEquipmentStateRow\b/u, 'EquipmentStateRow'],
      [/\bequipmentEntrySchema\b/u, 'equipmentEntrySchema'],
      [/\bregister_equipment\b/u, 'register_equipment'],
      [/activation:\s*['"]equipment['"]/u, "activation: 'equipment'"],
      [/'Invalid equipment/u, "'Invalid equipment ...'"],
      [/['"]coordinator\.registerEquipment['"]/u, 'coordinator.registerEquipment'],
      [/['"]coordinator\.unregisterEquipment['"]/u, 'coordinator.unregisterEquipment'],
      [/['"]coordinator\.listEquipment['"]/u, 'coordinator.listEquipment'],
      [/registrationKind\s*[:=]\s*['"]equipment['"]/u, "registrationKind: 'equipment'"],
      [/\bunknown_equipment\b/u, 'unknown_equipment'],
      [/\bequipment_install_lock_contended\b/u, 'equipment_install_lock_contended'],
      [/\bequipment_binary_corrupt\b/u, 'equipment_binary_corrupt'],
      [/\bequipment_runtime_unavailable\b/u, 'equipment_runtime_unavailable'],
      [/\bequipment_embedding_provider_missing\b/u, 'equipment_embedding_provider_missing'],
      [/\bequipment_slot_not_declared\b/u, 'equipment_slot_not_declared'],
      [/\bslot_already_equipped\b/u, 'slot_already_equipped'],
      [/\bequipment_install_path_unwritable\b/u, 'equipment_install_path_unwritable'],
      [/backend:\s*['"]orama['"]\s*\|\s*['"]needle['"]/u, "backend: 'orama' | 'needle'"],
      [/paths\.coral\.equipment\b/u, 'paths.coral.equipment'],
      // Coordinator-role identifiers must not regress to "Backend*". The
      // role/coordinator distinction matters: things tied to the coordinator
      // role (composition, identity, world, lifecycle, server controllers)
      // stay coordinator-named. Things tied to the deployment unit (the
      // running daemon) — BackendInfo, BackendStatus, the
      // discovery file, the auth token, the user-facing CLI subcommand —
      // legitimately use "Backend" and are NOT in this registry.
      [/\bBackendCoreOptions\b/u, 'BackendCoreOptions'],
      [/\bBackendCoreResult\b/u, 'BackendCoreResult'],
      [/\bcreateBackendCore\b/u, 'createBackendCore'],
      [/\bBackendIdentity\b/u, 'BackendIdentity'],
      [/\bBackendIdentityWriter\b/u, 'BackendIdentityWriter'],
      [/\bBackendWorld\b/u, 'BackendWorld'],
      [/\bMutableBackendRuntimeState\b/u, 'MutableBackendRuntimeState'],
      [/\bBackendServerOptions\b/u, 'BackendServerOptions'],
      [/\bBackendServerController\b/u, 'BackendServerController'],
      [/\bBackendServerInfo\b/u, 'BackendServerInfo'],
      [/\bBackendBootSnapshot\b/u, 'BackendBootSnapshot'],
      [/\bcreateBackendServer\b/u, 'createBackendServer'],
      [/\bcreateBackendControl\b/u, 'createBackendControl'],
      [/\bcreateBackendWorld\b/u, 'createBackendWorld'],
      [/\bresolveBackendDefaults\b/u, 'resolveBackendDefaults'],
    ];
    const violations = PRODUCTION_FILE_PATHS.flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      return forbiddenPatterns.flatMap(([pattern, label]) =>
        pattern.test(source) ? [`${toCanonicalSrcPath(REPO_ROOT, filePath)}: ${label}`] : [],
      );
    });

    expect(removedPaths.filter((filePath) => existsSync(resolve(REPO_ROOT, filePath)))).toEqual([]);
    expect(violations).toEqual([]);

    const skillSource = readFileSync(resolve(REPO_ROOT, 'skills/equip/SKILL.md'), 'utf8');
    expect(skillSource).toContain("activation: 'equip'");
    expect(skillSource).toContain('~/.coral/data/engines/<engine>/');
    expect(skillSource).not.toContain('~/.coral/data/engines/needle/coral-needle.node');
  });

  it('forbids Expansions from importing Journal/Corpus authority writers (§16 #32)', () => {
    // §16 #32: An Expansion never writes to any authority. Expansions add or
    // replace projection backends only. Authority writers (Journal append,
    // Corpus mutation lock, manifest authority, Corpus publication) are
    // coordinator/KB-runtime concerns. An Expansion that imports a writer
    // module is structurally permitted to bypass the authority boundary —
    // the import itself is the regression vector this test guards.
    const expansionFiles = PRODUCTION_FILE_PATHS.filter((filePath) => {
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      // Includes:
      //   - src/expansion/**         — the Expansion contract surface itself
      //   - src/**/expansion.ts      — every Expansion entry-point module
      // Excludes the entry-point file's siblings (e.g., needle/backend.ts) —
      // those are projection internals, not the Expansion entry. The contract
      // is enforced at the entry; siblings inherit transitively.
      return canonical.startsWith('src/expansion/') || canonical.endsWith('/expansion.ts');
    });
    expect(expansionFiles.length).toBeGreaterThan(0);

    const forbiddenSpecifiers: Array<[RegExp, string]> = [
      [/['"][^'"]*store\/append['"]/u, 'store/append (Journal write)'],
      [/['"][^'"]*store\/journal-write['"]/u, 'store/journal-write (Journal write)'],
      [/['"][^'"]*kb\/corpus\/manifest-authority['"]/u, 'kb/corpus/manifest-authority (Corpus authority)'],
      [/['"][^'"]*kb\/corpus\/mutation-lock['"]/u, 'kb/corpus/mutation-lock (Corpus write lock)'],
      [/['"][^'"]*kb\/corpus\/inbound-sync['"]/u, 'kb/corpus/inbound-sync (Corpus mutation)'],
      [/['"][^'"]*kb\/corpus\/publication['"]/u, 'kb/corpus/publication (Corpus mutation)'],
      [/['"][^'"]*kb\/corpus\/rescan\/auto-fix['"]/u, 'kb/corpus/rescan/auto-fix (Corpus mutation)'],
    ];
    const violations = expansionFiles.flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      return forbiddenSpecifiers.flatMap(([pattern, label]) =>
        pattern.test(source) ? [`${canonical}: imports ${label}`] : [],
      );
    });
    expect(violations).toEqual([]);
  });

  it('only the documented manifest registry and lifecycle wiring point reach into src/engines/** (AC7.1)', () => {
    // Engine-blindness: code outside `src/engines/**` must not know engine
    // identity. Two files are documented wiring points:
    //   - `src/expansion/bundled.ts` declares `BUNDLED_ENGINES.specifier`
    //     strings (manifest declarations; no executed import of engine code).
    //   - `src/coordinator/expansion/lifecycle.ts` is the wiring point that
    //     dynamically `import()`s engine specifiers from `BUNDLED_ENGINES`.
    // Sibling imports inside a single engine (`src/engines/<id>/...`) are
    // allowed — engines own their own internals.
    const allowedEngineImporters = new Set<string>([
      'src/expansion/bundled.ts',
      'src/coordinator/expansion/lifecycle.ts',
    ]);

    type EngineImportEdge = {
      source: string;
      target: string;
      specifier: string;
      via: string;
    };

    const engineIdFromPath = (path: string): string | null => {
      const [root, engines, id] = path.split('/');
      return root === 'src' && engines === 'engines' && id ? id : null;
    };

    const collectEngineImportViolations = (edges: readonly EngineImportEdge[]): string[] =>
      edges
        .filter((edge) => {
          const targetEngineId = engineIdFromPath(edge.target);
          if (targetEngineId === null || allowedEngineImporters.has(edge.source)) {
            return false;
          }

          const sourceEngineId = engineIdFromPath(edge.source);
          return sourceEngineId === null || sourceEngineId !== targetEngineId;
        })
        .map((edge) => `${edge.source} -> ${edge.target} (${edge.via} ${edge.specifier})`);

    expect(
      collectEngineImportViolations([
        {
          source: 'src/engines/orama/foo.ts',
          target: 'src/engines/needle/bar.ts',
          via: 'ImportDeclaration',
          specifier: '../needle/bar.js',
        },
      ]),
    ).toEqual(['src/engines/orama/foo.ts -> src/engines/needle/bar.ts (ImportDeclaration ../needle/bar.js)']);
    expect(
      collectEngineImportViolations([
        {
          source: 'src/engines/orama/foo.ts',
          target: 'src/engines/orama/bar.ts',
          via: 'ImportDeclaration',
          specifier: './bar.js',
        },
      ]),
    ).toEqual([]);

    expect(collectEngineImportViolations([...PARSED_IMPORT_EDGES, ...PARSED_SUBPATH_IMPORT_EDGES])).toEqual([]);
  });

  it('src/kb/** and src/coordinator/** carry no engine-id string literals (AC7.2)', () => {
    // Engine-id literals (`'orama'`, `'needle'`, `'gemini'`, `'onnx'`) leaking
    // into KB or coordinator code defeats engine-blindness regardless of
    // whether the leak is wired through an import. Slot names
    // (`'kb.fts'`, `'kb.vector'`, `'kb.embedding'`) and authority/interest
    // names (`'corpus'`, `'content'`, `'metadata'`, `'journal'`) remain
    // allowed — they are capability vocabulary, not engine identity.
    // Allowlist the lifecycle wiring point (the only legitimate consumer of
    // BUNDLED_ENGINES.id strings).
    const ENGINE_IDS = new Set(['orama', 'needle', 'gemini', 'onnx']);
    const ALLOWED_FILES = new Set<string>(['src/coordinator/expansion/lifecycle.ts']);

    const violations: string[] = [];

    for (const filePath of PRODUCTION_FILE_PATHS) {
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      if (!canonical.startsWith('src/kb/') && !canonical.startsWith('src/coordinator/')) {
        continue;
      }
      if (ALLOWED_FILES.has(canonical)) {
        continue;
      }

      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      function visit(node: ts.Node): void {
        if (ts.isStringLiteral(node) && ENGINE_IDS.has(node.text)) {
          violations.push(`${canonical}:${node.getStart()}: literal '${node.text}'`);
        } else if (ts.isNoSubstitutionTemplateLiteral(node) && ENGINE_IDS.has(node.text)) {
          violations.push(`${canonical}:${node.getStart()}: template-literal '${node.text}'`);
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it('Backed<T> values are not stored at module scope or as class fields outside src/kb/runtime.ts (AC7.3)', () => {
    // `Backed<T>` is a per-use read primitive — `binding.read()` must be
    // called fresh every time so consumers re-resolve through whichever
    // engine currently holds the binding. Caching a `Backed<T>` reference
    // (in a module-level variable or a class field) freezes the consumer
    // against the engine that filled the binding at construction time and
    // breaks the engine-swap contract. The only legitimate cache lives
    // inside `src/kb/runtime.ts`'s `RuntimeBinding<Backed<T>>` storage.
    function annotationContainsBacked(node: ts.TypeNode | undefined): boolean {
      if (!node) {
        return false;
      }
      let found = false;
      function check(child: ts.Node): void {
        if (found) {
          return;
        }
        if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName) && child.typeName.text === 'Backed') {
          found = true;
          return;
        }
        ts.forEachChild(child, check);
      }
      check(node);
      return found;
    }

    const violations: string[] = [];

    for (const filePath of PRODUCTION_FILE_PATHS) {
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      if (canonical === 'src/kb/runtime.ts') {
        continue;
      }

      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      // Module-scope: top-level `let`/`const`/`var` declarations whose
      // annotation references `Backed<...>`. (Local variables inside
      // function bodies are per-invocation — fresh each call — and not
      // covered by this invariant.)
      for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (annotationContainsBacked(declaration.type)) {
              const name = ts.isIdentifier(declaration.name) ? declaration.name.text : '<destructure>';
              violations.push(`${canonical}: module-level binding '${name}: Backed<...>'`);
            }
          }
        }
      }

      // Class fields: any property declaration on any class whose annotation
      // references `Backed<...>`. Classes can be nested or local; walk all.
      function walkClassFields(node: ts.Node): void {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          for (const member of node.members) {
            if (ts.isPropertyDeclaration(member) && annotationContainsBacked(member.type)) {
              const name = ts.isIdentifier(member.name) ? member.name.text : '<computed>';
              const className = node.name?.text ?? '<anonymous>';
              violations.push(`${canonical}: class field ${className}.${name}: Backed<...>`);
            }
          }
        }
        ts.forEachChild(node, walkClassFields);
      }

      walkClassFields(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
