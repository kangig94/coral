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
const SECURITY_POLICY_ROOT = 'src/security/policy';
const EXECUTION_ROOT = ['src', 'execution'].join('/');
const CLIENT_ROOT = ['src', 'client'].join('/');
const SKILLS_ROOT = ['src', 'skills'].join('/');
const SHARED_ROOT = ['src', 'shared'].join('/');
const SIMULATION_ROOT = ['src', 'simulation'].join('/');
const RETIRED_PRIVATE_STATE_ROOT = 'src/_retired';
const ROOT_SCENARIOS_ROOT = 'scenarios';
const DEBUG_SIMULATION_SCENARIOS_ROOT = ['tools', 'simulation', 'scenarios'].join('/');
const RETIRED_PROVIDERS_CONTINUITY_MUTATION = ['src', 'providers', 'continuity-mutation.ts'].join('/');
const RETIRED_STATUS_SCHEMA_FAULT = ['stale', 'status', 'schema'].join('_');
const RETIRED_TEXT_ARTIFACT_LOCK_METHOD = ['ensureTextArtifacts', 'FreshUnderLock'].join('');
const RETIRED_KB_DAEMON_ARG = '--kb-daemon';
const RETIRED_KB_DAEMON_PLAINTEXT_SHUTDOWN = 'Plain-text shutdown remains supported';
const RETIRED_KB_DAEMON_OLD_SUPERVISORS = 'old supervisors';
const PROVIDERS_ROOT = 'src/providers';
const SESSIONS_SHELL_ROOT = 'src/sessions/shell';
const STORE_QUERIES_ROOT = 'src/store/queries';
const WORKFLOW_PROVIDER_ALLOWLIST_TARGET = 'src/providers/catalog.ts';
const NEEDLE_BACKEND_TARGET = 'src/engines/needle/backend.ts';
const SESSION_FAULT_EVENTS = 'src/sessions/event-builders.ts';
const COORDINATOR_TERMINAL_MATERIALIZER = 'src/coordinator/services/terminal-materializer.ts';
const JOBS_TERMINAL_RECORDING = 'src/jobs/terminal/recording.ts';
const KB_PATHS_MODULE = 'src/kb/paths.ts';
const KB_JOB_RECORDER = 'src/jobs/kb/recorder.ts';
const DURABLE_TRANSPORT_MODULE = 'src/coordinator/live/durable-transport.ts';
const PROVIDER_SERVER_TRANSPORT_MODULE = 'src/coordinator/live/provider-server-transport.ts';
const CONSUMER_DRIVER_MODULE = 'src/projection-consumers/index.ts';

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
  // src/workflow/stale-recovery.ts formats a continuation-lease expiry from
  // `options.time.now()`; the clock value is injected through the workflow port.
  // src/kb/curate/community/generated-projection-store.ts formats a port-sourced
  // clock (`new Date(this.time.now())`) to an ISO date; the millis come from the
  // injected TimePort, not ambient time — the same deterministic format step as memo.ts.
  const allowed = new Set([
    'src/kb/env.ts',
    'src/discuss/transcript.ts',
    'src/kb/paths.ts',
    'src/kb/ops/memo.ts',
    'src/kb/curate/community/generated-projection-store.ts',
    'src/workflow/stale-recovery.ts',
    'src/providers/claude/appserver/controller.ts',
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
    // `LaunchPool` is conceptually owned by the admission contract — it
    // selects an admission pool. `jobs/launch.ts` propagates the choice
    // through launch records but does not define the type.
    expect(collectLaunchPoolDefinitions()).toEqual(['src/jobs/contracts/admission.ts']);

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
  it('security policy imports no I/O ports, domains, transport, or coordinator', () => {
    const violations = collectViolations(
      SECURITY_POLICY_ROOT,
      'src/security/policy must stay pure authorization data',
      'move I/O, domain, transport, and coordinator dependencies outside the pure security policy.',
      (target) =>
        target === 'src/infra/port-types.ts' ||
        target === 'src/runtime/ports.ts' ||
        target.startsWith('src/jobs/') ||
        target.startsWith('src/sessions/') ||
        target.startsWith('src/discuss/') ||
        target.startsWith('src/workflow/') ||
        target.startsWith('src/kb/') ||
        target.startsWith('src/providers/') ||
        target.startsWith('src/expansion/') ||
        target.startsWith('src/engines/') ||
        target.startsWith('src/store/') ||
        target.startsWith('src/read-model/') ||
        target.startsWith('src/projection-consumers/') ||
        target.startsWith('src/kb-daemon/') ||
        target.startsWith('src/transport/') ||
        target.startsWith('src/coordinator/'),
    );

    assertNoViolations(violations);
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
  it('kb operation failure journal facts are centralized in the jobs-owned KB recorder', () => {
    expect(collectKbOperationFailureWriters()).toEqual([KB_JOB_RECORDER]);
  });
  it('large coordinator transport and consumer-driver component stay split by responsibility', () => {
    expect(PRODUCTION_SOURCE_FILES).toContain(PROVIDER_SERVER_TRANSPORT_MODULE);
    expect(PRODUCTION_SOURCE_FILES).toContain(CONSUMER_DRIVER_MODULE);
    // design-philosophy.md §9.6: cohesive components with enough sibling files
    // should subdivide under a named directory instead of growing a root magnet.
    expect(PRODUCTION_SOURCE_FILES).toContain('src/projection-consumers/state.ts');
    expect(PRODUCTION_SOURCE_FILES).toContain('src/projection-consumers/persistence.ts');
    expect(PRODUCTION_SOURCE_FILES).toContain('src/projection-consumers/registration.ts');
    expect(PRODUCTION_SOURCE_FILES).toContain('src/projection-consumers/freshness-waiter.ts');
    expect(PRODUCTION_SOURCE_FILES).toContain('src/projection-consumers/authority-apply.ts');

    const durableTransportSource = readFileSync(resolve(REPO_ROOT, DURABLE_TRANSPORT_MODULE), 'utf8');
    expect(durableTransportSource).not.toContain('createInterface');
    expect(durableTransportSource).not.toContain('ProviderServerEntry');
  });
  it('coordinator root forbids content-blank consumer-driver-support magnet', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain('src/projection-consumers-support.ts');
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
    expect(
      collectProductionStringResidue([
        RETIRED_STATUS_SCHEMA_FAULT,
        RETIRED_TEXT_ARTIFACT_LOCK_METHOD,
        RETIRED_KB_DAEMON_ARG,
        RETIRED_KB_DAEMON_PLAINTEXT_SHUTDOWN,
        RETIRED_KB_DAEMON_OLD_SUPERVISORS,
      ]),
    ).toEqual([]);
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
  it('kb/corpus/* must not import the runtime facade module', () => {
    const runtimeFacadeImport = /from\s+['"]\.\.\/runtime(?:\.js)?['"]/u;
    const violations = listFilesRecursive(resolve(REPO_ROOT, 'src/kb/corpus'), (filePath) => filePath.endsWith('.ts'))
      .flatMap((filePath) => {
        const source = readFileSync(filePath, 'utf8');
        return runtimeFacadeImport.test(source) ? [toCanonicalSrcPath(REPO_ROOT, filePath)] : [];
      })
      .sort();

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
  it('the removed src execution tree must remain deleted', () => {
    const executionFiles = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, EXECUTION_ROOT));
    expect(executionFiles).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, EXECUTION_ROOT))).toBe(false);
  });
  it('the removed src _retired private-state tree must remain deleted', () => {
    const retiredFiles = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, RETIRED_PRIVATE_STATE_ROOT));
    expect(retiredFiles).toEqual([]);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_PRIVATE_STATE_ROOT))).toBe(false);
  });
  it('content-blank filenames are forbidden anywhere under src/ (helpers/utils/shared magnets)', () => {
    // Catches the *pattern* that LLMs and humans re-invent: dump-bucket files
    // named for what they describe (nothing). These accumulate unrelated logic
    // and are the magnet anti-pattern from design-philosophy.md §7. The
    // `index.ts` and `types.ts` exceptions are documented there too.
    const forbiddenBaseNames = /^(?:helpers|helper|utils|util|shared|shared-utils|misc|common)\.ts$/u;
    const forbiddenSuffixes = /-(?:helpers|helper|utils|util|shared|shared-utils)\.ts$/u;
    const violations = PRODUCTION_SOURCE_FILES.filter((file) => {
      const base = file.split('/').pop() ?? '';
      return forbiddenBaseNames.test(base) || forbiddenSuffixes.test(base);
    });
    expect(violations).toEqual([]);
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
  it('production types.ts files remain declaration-only', () => {
    expect(collectRuntimeDeclarationsInTypesFiles()).toEqual([]);
  });
  it('unit and invariant tests do not carry quarantine residue', () => {
    expect(collectTestQuarantineResidue()).toEqual([]);
  });
  it('store schema baseline no longer contains projection_kb residue', () => {
    const initialSchema = readFileSync(resolve(REPO_ROOT, 'src/store/schema.sql'), 'utf8');

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
  it('infra/paths.ts is permanently retired (use infra/path/index and per-domain path modules)', () => {
    expect(existsSync(resolve(REPO_ROOT, 'src/infra/paths.ts'))).toBe(false);
  });
  it('production src/ imports infra/path/ subdir only via index.ts (sibling files stay subdir-internal)', () => {
    // The infra/path/ subdir is the path component: index.ts is the public
    // composer (used by runtime port construction); root/store/coordinator/
    // engine are private family builders. External src/ callers must go
    // through composeCoralPaths so that flavor-aware path resolution stays
    // funneled through one entry point. KB has a documented exception for
    // root.ts (cycle-break primitive needed for kbRuntimeDir).
    const COMPOSE_PUBLIC = 'src/infra/path/index.ts';
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
      'src/infra/path/index.ts',
      'src/infra/path/root.ts',
      'src/infra/plugin-registry.ts',
      'src/kb/paths.ts',
      'src/runtime/real.ts',
      'src/providers/claude/appserver/controller.ts',
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
          if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
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
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
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
    expect(source).toMatch(/host\.require\(KB_EMBEDDING_CAPABILITY\)/u);
  });
  it('kb domain modules do not compose runtimes or load engines', () => {
    // Composition (`createRealRuntime`, `createExpansionHost`, `createScope`)
    // and bundled-engine loading (`BUNDLED_ENGINES`, `loadBundledEngine`)
    // are coordinator/daemon concerns. The KB domain owns query
    // semantics and operations but never composes the runtime that runs
    // them.
    const forbiddenSpecifiers = ['runtime/real.js', 'expansion/bundled.js', 'expansion/host.js', 'expansion/scope.js'];
    const violations: string[] = [];
    for (const filePath of PRODUCTION_SOURCE_FILES) {
      if (!filePath.startsWith('src/kb/')) continue;
      const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
      for (const specifier of forbiddenSpecifiers) {
        if (
          source.includes(`from '${specifier.replace(/\.js$/, '')}`) ||
          source.includes(`'../../${specifier}'`) ||
          source.includes(`'../${specifier}'`)
        ) {
          violations.push(`${filePath} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
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
          if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
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
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
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
    // identity. Documented wiring points:
    //   - `src/expansion/bundled.ts` declares `BUNDLED_ENGINES.specifier`
    //     strings (manifest declarations; no executed import of engine code).
    //   - `src/kb-daemon/expansion/*` wiring files adapt engine
    //     modules into the KB daemon expansion lifecycle.
    // Sibling imports inside a single engine (`src/engines/<id>/...`) are
    // allowed — engines own their own internals.
    const allowedEngineImporters = new Set<string>([
      'src/expansion/bundled.ts',
      'src/kb-daemon/expansion/bundled-loaders.ts',
      'src/kb-daemon/expansion/kiwi-boot.ts',
      'src/kb-daemon/expansion/projection-reconcile.ts',
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

  it('engine-blind domains carry no engine-id string literals (AC7.2)', () => {
    // Engine-id literals (`'orama'`, `'needle'`, `'gemini'`, `'onnx'`) leaking
    // into KB, coordinator, CLI expansion, infra, or runtime code defeat
    // engine-blindness regardless of whether the leak is wired through an
    // import. Slot names
    // (`'kb.fts'`, `'kb.vector'`, `'kb.embedding'`) and authority/interest
    // names (`'corpus'`, `'content'`, `'metadata'`, `'journal'`) remain
    // allowed — they are capability vocabulary, not engine identity.
    const engineBlindScopes = ['src/kb/', 'src/coordinator/', 'src/cli/expansion/', 'src/infra/', 'src/runtime/'];
    const engineIds = new Set(['orama', 'needle', 'gemini', 'onnx', 'kb-scann']);

    const violations: string[] = [];

    for (const filePath of PRODUCTION_FILE_PATHS) {
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      if (!engineBlindScopes.some((scope) => canonical.startsWith(scope))) {
        continue;
      }

      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      function visit(node: ts.Node): void {
        if (ts.isStringLiteral(node) && engineIds.has(node.text)) {
          violations.push(`${canonical}:${node.getStart()}: literal '${node.text}'`);
        } else if (ts.isNoSubstitutionTemplateLiteral(node) && engineIds.has(node.text)) {
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
