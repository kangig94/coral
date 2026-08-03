/*
Architectural boundary guard for seams established by:
- e34d8d8: workflow/ may depend on provider discovery only through src/providers/catalog.ts, not provider implementations or provider internals.
This test enforces those boundaries with the TypeScript compiler API and treats import type, export ... from, typeof import('...'), and relative dynamic import('...') as boundary-crossing imports.
Known non-goals: computed import(variableName) and relative require('...') are intentionally not covered.
*/

// Shared scanning helpers stay extracted because the reused resolver and AST import scanner exceed the inline duplication threshold.
import { dirname, join, relative, resolve } from 'node:path';
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
  it('legacy-generation adoption is permanently retired (a previous generation is never imported)', () => {
    // The generation boundary exists to end the coupling to a previous
    // generation, so `gen2` builds its own state and leaves the legacy tree
    // alone. An import path is what made the old tree a precondition for
    // booting, which is the failure this deletion removes. It cannot come back
    // partially either: startup initializes the generated target, and adoption
    // renames the legacy root onto that same target, so any restored adoption
    // command would be dead on arrival.
    expect(existsSync(resolve(REPO_ROOT, 'src/store/legacy-store-adoption.ts'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'src/cli/store-adopt.ts'))).toBe(false);
    // `'legacy-adoptable'` also names a StoreFormatClassification variant, which
    // is a store-file concern (equal fingerprint, no version row) and unrelated
    // to importing a generation. Only the adoption vocabulary is banned.
    const offenders = PRODUCTION_FILE_PATHS.filter((file) =>
      /\badoptLegacyStore\b|\blegacy_adoption_\w+|\bstore-adopt\b/u.test(readFileSync(file, 'utf-8')),
    ).map((file) => toCanonicalSrcPath(REPO_ROOT, file));
    expect(offenders).toEqual([]);
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
    // below. The catalog ships three first-party expansions (gemini, onnx,
    // orama) — if any are missing, the filter is broken.
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
      // Excludes entry-point siblings (for example, an engine backend) —
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
          target: 'src/engines/onnx/bar.ts',
          via: 'ImportDeclaration',
          specifier: '../onnx/bar.js',
        },
      ]),
    ).toEqual(['src/engines/orama/foo.ts -> src/engines/onnx/bar.ts (ImportDeclaration ../onnx/bar.js)']);
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
    // Engine-id literals (`'orama'`, `'gemini'`, `'onnx'`) leaking
    // into KB, coordinator, CLI expansion, infra, or runtime code defeat
    // engine-blindness regardless of whether the leak is wired through an
    // import. Slot names
    // (`'kb.fts'`, `'kb.vector'`, `'kb.embedding'`) and authority/interest
    // names (`'corpus'`, `'content'`, `'metadata'`, `'journal'`) remain
    // allowed — they are capability vocabulary, not engine identity.
    const engineBlindScopes = ['src/kb/', 'src/coordinator/', 'src/cli/expansion/', 'src/infra/', 'src/runtime/'];
    const engineIds = new Set(['orama', 'gemini', 'onnx', 'kb-scann']);

    const violations: string[] = [];

    for (const filePath of PRODUCTION_FILE_PATHS) {
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      if (!engineBlindScopes.some((scope) => canonical.startsWith(scope))) {
        continue;
      }
      // The top-level KB reservation authority intentionally records the
      // exact Orama-owned directory so retirement can reject that path.
      if (canonical === 'src/runtime/kb-runtime-authority.ts') {
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

type RecoveryStartupBoundary = {
  readonly boundary: string;
  readonly startupRoot: { readonly file: string; readonly symbol: string };
  readonly compositionSite: string;
};

type RecoveryShutdownBoundary = {
  readonly boundary: string;
  readonly shutdownRoot: { readonly file: string; readonly symbol: string };
  readonly compositionSite: string;
};

const RECOVERY_STARTUP_BOUNDARIES: readonly RecoveryStartupBoundary[] = [
  {
    boundary: 'coordinator job recovery',
    startupRoot: {
      file: 'src/coordinator/services/recovery/startup-recovery.ts',
      symbol: 'runCoordinatorJobRecovery',
    },
    compositionSite: 'src/coordinator/services/recovery/index.ts',
  },
  {
    boundary: 'P3 discussion source/candidate',
    startupRoot: {
      file: 'src/discuss/shell/startup-recovery.ts',
      symbol: 'runDiscussionStartupRecovery',
    },
    compositionSite: 'src/discuss/shell/recovery.ts',
  },
  {
    boundary: 'P4 session retention',
    startupRoot: {
      file: 'src/sessions/startup-recovery.ts',
      symbol: 'runSessionStartupRecovery',
    },
    compositionSite: 'src/sessions/lifecycle-reactor.ts',
  },
  {
    boundary: 'P6/P7 workflow',
    startupRoot: {
      file: 'src/workflow/startup-recovery.ts',
      symbol: 'runWorkflowStartupRecovery',
    },
    compositionSite: 'src/workflow/recover.ts',
  },
  {
    boundary: 'AC13 stale-artifact prune',
    startupRoot: {
      file: 'src/coordinator/startup-recovery.ts',
      symbol: 'runStartupStaleArtifactPrune',
    },
    compositionSite: 'src/coordinator/lifecycle.ts',
  },
];

const RECOVERY_SHUTDOWN_BOUNDARIES: readonly RecoveryShutdownBoundary[] = [
  {
    boundary: 'AC13 crashed-job terminalization',
    shutdownRoot: {
      file: 'src/coordinator/shutdown-recovery.ts',
      symbol: 'runShutdownCrashTerminalization',
    },
    compositionSite: 'src/coordinator/lifecycle.ts',
  },
];

const RECOVERY_COMPOSITION_BOUNDARIES = [
  ...RECOVERY_STARTUP_BOUNDARIES.map(({ boundary, compositionSite }) => ({ boundary, compositionSite })),
  ...RECOVERY_SHUTDOWN_BOUNDARIES.map(({ boundary, compositionSite }) => ({ boundary, compositionSite })),
] as const;

const RECOVERY_FATAL_STARTUP_ROOT = {
  file: 'src/coordinator/index.ts',
  symbol: 'awaitRecoveryCursorBarrier',
} as const;

const RECOVERY_STARTUP_CAPABILITIES = [
  {
    file: 'src/discuss/shell/startup-recovery.ts',
    symbol: 'DiscussionCandidateSettlement',
  },
  {
    file: 'src/sessions/startup-recovery.ts',
    symbol: 'SessionRetentionWorkSettlement',
  },
] as const;

type RecoverySourceMatrixRow = {
  readonly boundary: RecoveryStartupBoundary['boundary'];
  readonly factory: string;
  readonly sourceModule: string;
  readonly rawAuthorities: readonly string[];
  readonly composite?: true;
};

// This is the canonical source matrix's factory and Future raw/receipt authority columns.
// Both inverse manifests below are derived from it so legacy decoded/aggregate symbols cannot
// accidentally become granted authorities.
const RECOVERY_SOURCE_MATRIX: readonly RecoverySourceMatrixRow[] = [
  {
    boundary: 'coordinator job recovery',
    factory: 'coordinatorJobRecoverySource',
    sourceModule: 'src/coordinator/services/recovery/coordinator-job-source.ts',
    rawAuthorities: ['scanCoordinatorJobRecoveryEnvelopes'],
  },
  {
    boundary: 'P3 discussion source/candidate',
    factory: 'discussionSourceRecoverySource',
    sourceModule: 'src/discuss/shell/discussion-source-recovery-source.ts',
    rawAuthorities: ['scanDiscussionSourceRows'],
  },
  {
    boundary: 'P3 discussion source/candidate',
    factory: 'discussionCandidateRecoverySource',
    sourceModule: 'src/discuss/shell/discussion-candidate-recovery-source.ts',
    rawAuthorities: ['scanDiscussionCandidateEnvelopes'],
  },
  {
    boundary: 'P4 session retention',
    factory: 'sessionProjectionRecoverySource',
    sourceModule: 'src/sessions/projection-recovery-source.ts',
    rawAuthorities: ['scanSessionProjectionRows'],
  },
  {
    boundary: 'P4 session retention',
    factory: 'sessionContinuationLeaseRecoverySource',
    sourceModule: 'src/sessions/continuation-lease-recovery-source.ts',
    rawAuthorities: ['scanPendingContinuationLeaseRows'],
  },
  {
    boundary: 'P4 session retention',
    factory: 'terminalRetentionOutcomeRecoverySource',
    sourceModule: 'src/sessions/terminal-retention-outcome-recovery-source.ts',
    rawAuthorities: ['scanTerminalRetentionOutcomeRows'],
  },
  {
    boundary: 'P4 session retention',
    factory: 'retentionReleasePairComponentSource',
    sourceModule: 'src/sessions/retention-release-pair-recovery-source.ts',
    rawAuthorities: ['scanRetentionReleaseAndTerminalRows'],
  },
  {
    boundary: 'P4 session retention',
    factory: 'retentionWorkItemRecoverySource',
    sourceModule: 'src/sessions/retention-work-item-recovery-source.ts',
    rawAuthorities: ['scanRetentionWorkRows', 'composeRetentionWorkItemReceipts'],
    composite: true,
  },
  {
    boundary: 'P6/P7 workflow',
    factory: 'workflowRecoverySource',
    sourceModule: 'src/workflow/recovery-source.ts',
    rawAuthorities: ['scanWorkflowRecoveryEnvelopes'],
  },
  {
    boundary: 'AC13 stale-artifact prune',
    factory: 'staleJobCleanupSource',
    sourceModule: 'src/jobs/stale-job-cleanup-recovery-source.ts',
    rawAuthorities: ['scanStaleJobCleanupRows'],
  },
  {
    boundary: 'AC13 crashed-job terminalization',
    factory: 'crashedJobTerminalizationSource',
    sourceModule: 'src/jobs/crashed-job-terminalization-recovery-source.ts',
    rawAuthorities: ['scanCrashedJobRows'],
  },
];

const RECOVERY_SOURCE_FACTORIES = RECOVERY_SOURCE_MATRIX.map((row) => ({
  name: row.factory,
  module: row.sourceModule,
  compositionSite: RECOVERY_COMPOSITION_BOUNDARIES.find((entry) => entry.boundary === row.boundary)!.compositionSite,
  composite: row.composite === true,
}));

const RECOVERY_RAW_AUTHORITIES = RECOVERY_SOURCE_MATRIX.flatMap((row) =>
  row.rawAuthorities.map((name) => ({
    name,
    module: row.sourceModule,
    factory: row.factory,
    allowedScanBody: `${row.sourceModule}:${row.factory} registered scan body`,
  })),
);

type RecoveryImportEdge = { readonly source: string; readonly target: string };

type RecoveryAuthorityViolation = {
  readonly offendingFile: string;
  readonly dependencyPath: readonly string[];
  readonly authorityDeclaration: string;
  readonly violatedRule: string;
  readonly allowedLocation: string;
};

type RecoveryAnalysisContext = {
  readonly projectRoot: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly productionSourceFiles: readonly ts.SourceFile[];
  readonly importEdges: readonly RecoveryImportEdge[];
  readonly allowedStartupCapabilities: readonly { readonly file: string; readonly symbol: string }[];
};

type RecoveryRuleSelection = {
  readonly phase1: boolean;
  readonly rawAuthority: boolean;
  readonly startupInputSeal: boolean;
};

type RecoveryFactoryInspection = {
  readonly manifest: (typeof RECOVERY_SOURCE_FACTORIES)[number];
  readonly declaration: ts.Declaration;
  readonly symbol: ts.Symbol;
  readonly scanBodies: readonly ts.Node[];
};

const RECOVERY_CONTAINMENT_MODULE = 'src/recovery/containment.ts';
const RECOVERY_FIXTURE_ROOT = resolve(REPO_ROOT, 'tests/invariants/fixtures/recovery-authority');

function createReadonlyProductionProgram(): ts.Program {
  const configPath = resolve(REPO_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT, undefined, configPath);
  return ts.createProgram({
    rootNames: PRODUCTION_FILE_PATHS,
    options: {
      ...parsed.options,
      composite: false,
      incremental: false,
      noEmit: true,
      tsBuildInfoFile: undefined,
    },
  });
}

function createRecoveryFixtureProgram(): ts.Program {
  const fixtureSources = new Map<string, string>();
  const fixtureFiles = listFilesRecursive(
    RECOVERY_FIXTURE_ROOT,
    (filePath) => filePath.endsWith('.ts.txt') && !filePath.includes('/_kernel/'),
  );

  for (const fixtureFile of fixtureFiles) {
    fixtureSources.set(fixtureFile.slice(0, -'.txt'.length), readFileSync(fixtureFile, 'utf8'));
  }

  const containmentKernel = readFileSync(resolve(RECOVERY_FIXTURE_ROOT, '_kernel/containment.ts.txt'), 'utf8');
  for (const projectName of ['valid', 'phase1', 'raw', 'startup']) {
    const containmentPath = resolve(RECOVERY_FIXTURE_ROOT, projectName, RECOVERY_CONTAINMENT_MODULE);
    if (!fixtureSources.has(containmentPath)) {
      fixtureSources.set(containmentPath, containmentKernel);
    }
  }

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  // Module resolution skips a directory it believes does not exist, so a virtual fixture file is
  // invisible unless its containing directories are reported too. Without this the fixtures resolve
  // only when some unrelated empty directory happens to be left on disk, which is not a test.
  const fixtureDirectories = new Set<string>();
  for (const fixturePath of fixtureSources.keys()) {
    for (let directory = dirname(fixturePath); directory.startsWith(RECOVERY_FIXTURE_ROOT); ) {
      fixtureDirectories.add(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  const defaultHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    directoryExists: (directoryName) =>
      fixtureDirectories.has(directoryName) || (defaultHost.directoryExists?.(directoryName) ?? false),
    fileExists: (fileName) => fixtureSources.has(fileName) || defaultHost.fileExists(fileName),
    readFile: (fileName) => fixtureSources.get(fileName) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const source = fixtureSources.get(fileName);
      if (source !== undefined) {
        return ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    writeFile: () => {
      throw new Error('Recovery authority fixture Programs are read-only.');
    },
  };

  return ts.createProgram({ rootNames: [...fixtureSources.keys()], options, host });
}

const RECOVERY_PRODUCTION_PROGRAM = createReadonlyProductionProgram();
const RECOVERY_FIXTURE_PROGRAM = createRecoveryFixtureProgram();

function toAnalysisPath(context: RecoveryAnalysisContext, fileName: string): string {
  return relative(context.projectRoot, fileName).replaceAll('\\', '/');
}

function sourceFileAt(context: RecoveryAnalysisContext, filePath: string): ts.SourceFile | undefined {
  return context.program.getSourceFile(resolve(context.projectRoot, filePath));
}

function createRecoveryAnalysisContext(
  program: ts.Program,
  projectRoot: string,
  importEdges?: readonly RecoveryImportEdge[],
  allowedStartupCapabilities: readonly { readonly file: string; readonly symbol: string }[] = [],
): RecoveryAnalysisContext {
  const srcRoot = `${resolve(projectRoot, 'src')}/`;
  const contextWithoutEdges = {
    projectRoot,
    program,
    checker: program.getTypeChecker(),
    productionSourceFiles: program
      .getSourceFiles()
      .filter((sourceFile) => sourceFile.fileName.startsWith(srcRoot) && !sourceFile.isDeclarationFile),
    allowedStartupCapabilities,
  };
  const context = { ...contextWithoutEdges, importEdges: importEdges ?? [] };
  return importEdges === undefined ? { ...context, importEdges: collectRecoveryImportEdges(context) } : context;
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function symbolAt(context: RecoveryAnalysisContext, node: ts.Node): ts.Symbol | undefined {
  return canonicalSymbol(context.checker, context.checker.getSymbolAtLocation(node));
}

function moduleSymbol(context: RecoveryAnalysisContext, sourceFile: ts.SourceFile): ts.Symbol | undefined {
  return context.checker.getSymbolAtLocation(sourceFile);
}

function exportedSymbol(context: RecoveryAnalysisContext, filePath: string, exportName: string): ts.Symbol | undefined {
  const sourceFile = sourceFileAt(context, filePath);
  const symbol = sourceFile && moduleSymbol(context, sourceFile);
  if (!symbol) {
    return undefined;
  }
  return canonicalSymbol(
    context.checker,
    context.checker.getExportsOfModule(symbol).find((entry) => entry.name === exportName),
  );
}

function topLevelDeclarationSymbol(
  context: RecoveryAnalysisContext,
  filePath: string,
  declarationName: string,
): ts.Symbol | undefined {
  const sourceFile = sourceFileAt(context, filePath);
  if (!sourceFile) {
    return undefined;
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === declarationName) {
      return symbolAt(context, statement.name);
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === declarationName) {
        return symbolAt(context, declaration.name);
      }
    }
  }
  return undefined;
}

function moduleSpecifierTarget(
  context: RecoveryAnalysisContext,
  sourceFile: ts.SourceFile,
  specifier: ts.StringLiteralLike,
): string | undefined {
  const importedModule = canonicalSymbol(context.checker, context.checker.getSymbolAtLocation(specifier));
  const moduleDeclaration = importedModule?.declarations?.find(ts.isSourceFile);
  if (moduleDeclaration) {
    return toAnalysisPath(context, moduleDeclaration.fileName);
  }

  if (specifier.text.startsWith('.')) {
    const candidate = resolve(dirname(sourceFile.fileName), specifier.text.replace(/\.js$/u, '.ts'));
    if (context.program.getSourceFile(candidate)) {
      return toAnalysisPath(context, candidate);
    }
  }
  if (specifier.text.startsWith('#tests/')) {
    return specifier.text.replace(/^#tests\//u, 'tests/');
  }
  if (specifier.text.startsWith('#tools/testing/')) {
    return specifier.text.replace(/^#tools\//u, 'tools/');
  }
  return undefined;
}

function collectRecoveryImportEdges(context: RecoveryAnalysisContext): RecoveryImportEdge[] {
  const edges: RecoveryImportEdge[] = [];
  for (const sourceFile of context.productionSourceFiles) {
    const source = toAnalysisPath(context, sourceFile.fileName);
    for (const statement of sourceFile.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier
          ? statement.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        continue;
      }
      const target = moduleSpecifierTarget(context, sourceFile, specifier);
      if (target) {
        edges.push({ source, target });
      }
    }
  }
  return edges;
}

function dependencyPath(context: RecoveryAnalysisContext, source: string, authorityFile: string): readonly string[] {
  if (source === authorityFile) {
    return [source];
  }

  const targetsBySource = new Map<string, string[]>();
  for (const edge of context.importEdges) {
    const targets = targetsBySource.get(edge.source) ?? [];
    targets.push(edge.target);
    targetsBySource.set(edge.source, targets);
  }

  const queue: string[][] = [[source]];
  const visited = new Set([source]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    for (const target of targetsBySource.get(path.at(-1)!) ?? []) {
      if (target === authorityFile) {
        return [...path, target];
      }
      if (!visited.has(target)) {
        visited.add(target);
        queue.push([...path, target]);
      }
    }
  }
  return [source, authorityFile];
}

function declarationDescription(context: RecoveryAnalysisContext, symbol: ts.Symbol): string {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) {
    return symbol.name;
  }
  const sourceFile = declaration.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
  return `${toAnalysisPath(context, sourceFile.fileName)}:${line + 1}:${symbol.name}`;
}

function unresolvedAuthorityDescription(context: RecoveryAnalysisContext, node: ts.Node, name: string): string {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${toAnalysisPath(context, sourceFile.fileName)}:${line + 1}:${name}`;
}

function makeRecoveryViolation(
  context: RecoveryAnalysisContext,
  node: ts.Node,
  authority: ts.Symbol | string,
  violatedRule: string,
  allowedLocation: string,
): RecoveryAuthorityViolation {
  const offendingFile = toAnalysisPath(context, node.getSourceFile().fileName);
  const authorityDeclaration = typeof authority === 'string' ? authority : declarationDescription(context, authority);
  const authorityFile = authorityDeclaration.split(':')[0];
  return {
    offendingFile,
    dependencyPath: dependencyPath(context, offendingFile, authorityFile),
    authorityDeclaration,
    violatedRule,
    allowedLocation,
  };
}

function formatRecoveryViolations(violations: readonly RecoveryAuthorityViolation[]): string {
  return violations
    .map((violation) =>
      [
        `Offending file: ${violation.offendingFile}`,
        `Dependency path: ${violation.dependencyPath.join(' -> ')}`,
        `Authority declaration: ${violation.authorityDeclaration}`,
        `Violated rule: ${violation.violatedRule}`,
        `Allowed source scan body or composition site: ${violation.allowedLocation}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function assertNoRecoveryViolations(violations: readonly RecoveryAuthorityViolation[]): void {
  if (violations.length > 0) {
    expect.fail(formatRecoveryViolations(violations));
  }
}

function assertRecoveryMutationFailure(
  mutation: string,
  violations: readonly RecoveryAuthorityViolation[],
  expected: { readonly offendingFile: string; readonly rule: string },
): void {
  const matching = violations.filter(
    (violation) => violation.offendingFile === expected.offendingFile && violation.violatedRule.includes(expected.rule),
  );
  expect(
    matching,
    `${mutation}: analyzer did not reject the mutation\n${formatRecoveryViolations(violations)}`,
  ).not.toEqual([]);

  const diagnostic = formatRecoveryViolations(matching);
  expect(diagnostic).toContain(`Offending file: ${expected.offendingFile}`);
  expect(diagnostic).toContain('Dependency path:');
  expect(diagnostic).toContain('Authority declaration:');
  expect(diagnostic).toContain(`Violated rule: ${matching[0].violatedRule}`);
  expect(diagnostic).toContain('Allowed source scan body or composition site:');
}

function isNodeWithin(node: ts.Node, container: ts.Node): boolean {
  return (
    node.getSourceFile() === container.getSourceFile() &&
    node.getStart() >= container.getStart() &&
    node.getEnd() <= container.getEnd()
  );
}

function isDeclarationName(node: ts.Node, symbol: ts.Symbol): boolean {
  return symbol.declarations?.some((declaration) => (declaration as ts.NamedDeclaration).name === node) ?? false;
}

function hasExportModifier(node: ts.Node): boolean {
  const declaration = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  return (
    ts.canHaveModifiers(declaration) &&
    (ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function exportSite(sourceFile: ts.SourceFile, exportName: string): ts.Node {
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const specifier = statement.exportClause.elements.find((element) => element.name.text === exportName);
      if (specifier) {
        return specifier;
      }
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name?.text === exportName
    ) {
      return statement.name;
    }
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === exportName,
      );
      if (declaration) {
        return declaration.name;
      }
    }
  }
  return sourceFile;
}

function visitNodes(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => visitNodes(child, visit));
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveObjectLiteral(
  context: RecoveryAnalysisContext,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ts.ObjectLiteralExpression | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped;
  }
  if (!ts.isIdentifier(unwrapped)) {
    return undefined;
  }

  const symbol = symbolAt(context, unwrapped);
  if (!symbol || seen.has(symbol)) {
    return undefined;
  }
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    ? resolveObjectLiteral(context, declaration.initializer, seen)
    : undefined;
}

function functionLikeDeclaration(declaration: ts.Declaration): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }
  const initializer = unwrapExpression(declaration.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : undefined;
}

function exactNamedType(
  context: RecoveryAnalysisContext,
  typeNode: ts.TypeNode | undefined,
  expectedSymbol: ts.Symbol | undefined,
): boolean {
  if (!typeNode || !expectedSymbol || !ts.isTypeReferenceNode(typeNode)) {
    return false;
  }
  return symbolAt(context, typeNode.typeName) === expectedSymbol && typeNode.typeArguments?.length === 1;
}

function isPreEnumeratedType(context: RecoveryAnalysisContext, typeNode: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(typeNode) || ts.isTypeOperatorNode(typeNode)) {
    return isPreEnumeratedType(context, typeNode.type);
  }
  if (ts.isArrayTypeNode(typeNode) || ts.isTupleTypeNode(typeNode)) {
    return true;
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((member) => isPreEnumeratedType(context, member));
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();
    if (
      /^(?:Array|ReadonlyArray|Iterable|AsyncIterable|Iterator|AsyncIterator|Generator|AsyncGenerator|Set|ReadonlySet|Map|ReadonlyMap)$/u.test(
        typeName,
      )
    ) {
      return true;
    }
    return typeNode.typeArguments?.some((argument) => isPreEnumeratedType(context, argument)) ?? false;
  }

  const type = context.checker.getTypeFromTypeNode(typeNode);
  return context.checker.isArrayType(type) || context.checker.isTupleType(type);
}

function isExactReadonlyReceiptArray(
  context: RecoveryAnalysisContext,
  typeNode: ts.TypeNode | undefined,
  receiptSymbol: ts.Symbol | undefined,
): boolean {
  if (!typeNode || !receiptSymbol || !ts.isTypeOperatorNode(typeNode)) {
    return false;
  }
  if (typeNode.operator !== ts.SyntaxKind.ReadonlyKeyword || !ts.isArrayTypeNode(typeNode.type)) {
    return false;
  }
  return exactNamedType(context, typeNode.type.elementType, receiptSymbol);
}

function propertyNameText(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function registeredScanBody(
  context: RecoveryAnalysisContext,
  objectLiteral: ts.ObjectLiteralExpression,
): ts.Node | undefined {
  const scanProperty = objectLiteral.properties.find((property) => propertyNameText(property) === 'scan');
  if (!scanProperty) {
    return undefined;
  }
  if (ts.isMethodDeclaration(scanProperty)) {
    return scanProperty.body ?? scanProperty;
  }
  if (ts.isPropertyAssignment(scanProperty)) {
    const initializer = unwrapExpression(scanProperty.initializer);
    if (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer) ||
      context.checker.getTypeAtLocation(initializer).getCallSignatures().length > 0
    ) {
      return initializer;
    }
    return undefined;
  }
  if (ts.isShorthandPropertyAssignment(scanProperty)) {
    return context.checker.getTypeAtLocation(scanProperty.name).getCallSignatures().length > 0
      ? scanProperty.name
      : undefined;
  }
  return undefined;
}

function inspectRecoveryFactories(
  context: RecoveryAnalysisContext,
  violations: RecoveryAuthorityViolation[],
  reportPhase1Violations: boolean,
): RecoveryFactoryInspection[] {
  const recoverySourceSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'RecoverySource');
  const recoveryReceiptSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'RecoveryReceipt');
  const recoverySubjectSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'RecoverySubject');
  const defineSourceSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'defineRecoverySource');
  const defineCompositeSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'defineCompositeRecoverySource');
  const inspections: RecoveryFactoryInspection[] = [];

  for (const manifest of RECOVERY_SOURCE_FACTORIES) {
    const symbol = exportedSymbol(context, manifest.module, manifest.name);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!symbol || !declaration) {
      continue;
    }

    const functionLike = functionLikeDeclaration(declaration);
    const factoryNode = functionLike ?? declaration;
    const scanBodies: ts.Node[] = [];

    if (reportPhase1Violations && !functionLike) {
      violations.push(
        makeRecoveryViolation(
          context,
          declaration,
          symbol,
          'explicit-return: a source factory must be a directly declared function with an explicit RecoverySource<Raw> return',
          manifest.compositionSite,
        ),
      );
    }
    if (reportPhase1Violations && functionLike && !exactNamedType(context, functionLike.type, recoverySourceSymbol)) {
      violations.push(
        makeRecoveryViolation(
          context,
          functionLike,
          symbol,
          'explicit-return: inferred, aliased, intersected, or extended factory returns are forbidden',
          manifest.compositionSite,
        ),
      );
    }

    const factoryType = context.checker.getTypeOfSymbolAtLocation(symbol, declaration);
    for (const property of factoryType.getProperties()) {
      const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0] ?? declaration;
      const propertyType = context.checker.getTypeOfSymbolAtLocation(property, propertyDeclaration);
      if (reportPhase1Violations && propertyType.getCallSignatures().length > 0) {
        violations.push(
          makeRecoveryViolation(
            context,
            propertyDeclaration,
            symbol,
            'explicit-return: factories may not carry extra callable properties',
            manifest.compositionSite,
          ),
        );
      }
    }

    if (functionLike) {
      if (manifest.composite) {
        const exactCompositeInput =
          (functionLike.parameters.length === 1 ||
            (functionLike.parameters.length === 2 &&
              functionLike.parameters[1].type !== undefined &&
              ts.isTypeReferenceNode(functionLike.parameters[1].type) &&
              symbolAt(context, functionLike.parameters[1].type.typeName) === recoverySubjectSymbol &&
              functionLike.parameters[1].type.typeArguments === undefined)) &&
          isExactReadonlyReceiptArray(context, functionLike.parameters[0].type, recoveryReceiptSymbol);
        if (reportPhase1Violations && !exactCompositeInput) {
          violations.push(
            makeRecoveryViolation(
              context,
              functionLike.parameters[0] ?? functionLike,
              symbol,
              'lazy-factory: the registered composite factory accepts only readonly RecoveryReceipt<T>[] and an optional exact RecoverySubject',
              manifest.compositionSite,
            ),
          );
        }
      } else {
        for (const parameter of functionLike.parameters) {
          if (reportPhase1Violations && parameter.type && isPreEnumeratedType(context, parameter.type)) {
            violations.push(
              makeRecoveryViolation(
                context,
                parameter,
                symbol,
                'lazy-factory: a source factory may not accept an iterable or pre-enumerated result',
                manifest.compositionSite,
              ),
            );
          }
        }
      }

      const expectedDefinitionSymbol = manifest.composite ? defineCompositeSymbol : defineSourceSymbol;
      visitNodes(functionLike, (node) => {
        if (!ts.isCallExpression(node) || symbolAt(context, node.expression) !== expectedDefinitionSymbol) {
          return;
        }
        const definitionArgument = node.arguments[manifest.composite ? 1 : 0];
        const definition = definitionArgument && resolveObjectLiteral(context, definitionArgument);
        const scanBody = definition && registeredScanBody(context, definition);
        if (scanBody) {
          scanBodies.push(scanBody);
        } else if (reportPhase1Violations) {
          violations.push(
            makeRecoveryViolation(
              context,
              definitionArgument ?? node,
              symbol,
              'lazy-factory: registration must supply one resolvable callable scan body',
              manifest.compositionSite,
            ),
          );
        }
      });

      if (reportPhase1Violations && scanBodies.length === 0) {
        violations.push(
          makeRecoveryViolation(
            context,
            factoryNode,
            symbol,
            `source-module: ${manifest.name} must register through ${
              manifest.composite ? 'defineCompositeRecoverySource' : 'defineRecoverySource'
            }`,
            manifest.compositionSite,
          ),
        );
      }

      const row = RECOVERY_SOURCE_MATRIX.find((entry) => entry.factory === manifest.name)!;
      for (const authorityName of row.rawAuthorities) {
        const authority = topLevelDeclarationSymbol(context, row.sourceModule, authorityName);
        if (!authority) {
          continue;
        }
        visitNodes(factoryNode, (node) => {
          if (!ts.isIdentifier(node) || symbolAt(context, node) !== authority) {
            return;
          }
          if (scanBodies.some((scanBody) => isNodeWithin(node, scanBody))) {
            return;
          }
          if (reportPhase1Violations) {
            violations.push(
              makeRecoveryViolation(
                context,
                node,
                authority,
                'lazy-factory: a raw authority may be evaluated only inside the registered scan body',
                `${row.sourceModule}:${row.factory} registered scan body`,
              ),
            );
          }
        });
      }
    }

    inspections.push({ manifest, declaration, symbol, scanBodies });
  }
  return inspections;
}

function collectSourceDefinitionImportViolations(
  context: RecoveryAnalysisContext,
  violations: RecoveryAuthorityViolation[],
): void {
  const authorities = [
    exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'defineRecoverySource'),
    exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'defineCompositeRecoverySource'),
  ].filter((symbol): symbol is ts.Symbol => symbol !== undefined);

  for (const sourceFile of context.productionSourceFiles) {
    const sourcePath = toAnalysisPath(context, sourceFile.fileName);
    if (
      sourcePath === RECOVERY_CONTAINMENT_MODULE ||
      RECOVERY_SOURCE_MATRIX.some((row) => row.sourceModule === sourcePath)
    ) {
      continue;
    }
    visitNodes(sourceFile, (node) => {
      if (!ts.isIdentifier(node) && !ts.isElementAccessExpression(node)) {
        return;
      }
      const authority = symbolAt(context, node);
      if (!authority || !authorities.includes(authority) || isDeclarationName(node, authority)) {
        return;
      }
      violations.push(
        makeRecoveryViolation(
          context,
          node,
          authority,
          'source-module: recovery source definitions may be imported only by manifest-listed source modules',
          RECOVERY_SOURCE_MATRIX.map((row) => row.sourceModule).join(', '),
        ),
      );
    });
  }
}

function collectRegistryViolations(context: RecoveryAnalysisContext, violations: RecoveryAuthorityViolation[]): void {
  const registries = ['sourceDefinitions', 'receiptValues']
    .map((name) => topLevelDeclarationSymbol(context, RECOVERY_CONTAINMENT_MODULE, name))
    .filter((symbol): symbol is ts.Symbol => symbol !== undefined);

  for (const registry of registries) {
    const declaration = registry.valueDeclaration ?? registry.declarations?.[0];
    if (declaration && hasExportModifier(declaration)) {
      violations.push(
        makeRecoveryViolation(
          context,
          declaration,
          registry,
          'registry: recovery source and receipt registries must remain module-private',
          RECOVERY_CONTAINMENT_MODULE,
        ),
      );
    }
  }

  for (const sourceFile of context.productionSourceFiles) {
    if (toAnalysisPath(context, sourceFile.fileName) === RECOVERY_CONTAINMENT_MODULE) {
      continue;
    }
    visitNodes(sourceFile, (node) => {
      if (!ts.isIdentifier(node) && !ts.isElementAccessExpression(node)) {
        return;
      }
      const registry = symbolAt(context, node);
      if (!registry || !registries.includes(registry)) {
        return;
      }
      violations.push(
        makeRecoveryViolation(
          context,
          node,
          registry,
          'registry: only src/recovery/containment.ts may read a private recovery registry',
          RECOVERY_CONTAINMENT_MODULE,
        ),
      );
    });
  }
}

function collectSourceExportViolations(
  context: RecoveryAnalysisContext,
  violations: RecoveryAuthorityViolation[],
): void {
  for (const sourceFile of context.productionSourceFiles) {
    const sourcePath = toAnalysisPath(context, sourceFile.fileName);
    const allowedFactory = RECOVERY_SOURCE_FACTORIES.find((factory) => factory.module === sourcePath);
    if (!allowedFactory) continue;
    const sourceModuleSymbol = moduleSymbol(context, sourceFile);
    if (!sourceModuleSymbol) {
      continue;
    }
    for (const exported of context.checker.getExportsOfModule(sourceModuleSymbol)) {
      const canonical = canonicalSymbol(context.checker, exported);
      if (!canonical || (canonical.flags & ts.SymbolFlags.Value) === 0) {
        continue;
      }
      if (allowedFactory?.name === exported.name) {
        continue;
      }
      violations.push(
        makeRecoveryViolation(
          context,
          exportSite(sourceFile, exported.name),
          canonical,
          'source-module: a recovery source module may export only its exact named factory value',
          `${allowedFactory.module}:${allowedFactory.name}`,
        ),
      );
    }
  }
}

function collectTestHelperImportViolations(
  context: RecoveryAnalysisContext,
  violations: RecoveryAuthorityViolation[],
): void {
  for (const sourceFile of context.productionSourceFiles) {
    const moduleSpecifiers: ts.StringLiteralLike[] = [];
    visitNodes(sourceFile, (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        moduleSpecifiers.push(node.moduleSpecifier);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        moduleSpecifiers.push(node.arguments[0]);
      }
    });

    for (const specifier of moduleSpecifiers) {
      const target = moduleSpecifierTarget(context, sourceFile, specifier);
      if (!target || (!target.startsWith('tests/') && !target.startsWith('tools/testing/'))) {
        continue;
      }
      violations.push(
        makeRecoveryViolation(
          context,
          specifier,
          `${target}:test-helper`,
          'source-module: production modules may not import test code or test helpers',
          'tests/** and tools/testing/** are test-only',
        ),
      );
    }
  }
}

function collectRawAuthorityViolations(
  context: RecoveryAnalysisContext,
  inspections: readonly RecoveryFactoryInspection[],
  violations: RecoveryAuthorityViolation[],
): void {
  // Resolve every authority up front and key them by symbol, so the production tree is walked once
  // instead of once per authority. Walking per authority meant 12 full passes over 655 files with a
  // `getSymbolAtLocation` per identifier, which is what pushed this past the CI timeout.
  const authorities = new Map<
    ts.Symbol,
    {
      readonly declaration: ts.Node;
      readonly allowedScanBodies: readonly ts.Node[];
      readonly allowedScanBody: string;
    }
  >();
  for (const manifest of RECOVERY_RAW_AUTHORITIES) {
    const authority = topLevelDeclarationSymbol(context, manifest.module, manifest.name);
    const declaration = authority?.valueDeclaration ?? authority?.declarations?.[0];
    if (!authority || !declaration) {
      continue;
    }
    authorities.set(authority, {
      declaration,
      allowedScanBodies:
        inspections.find((inspection) => inspection.manifest.name === manifest.factory)?.scanBodies ?? [],
      allowedScanBody: manifest.allowedScanBody,
    });
  }
  if (authorities.size === 0) return;

  for (const sourceFile of context.productionSourceFiles) {
    visitNodes(sourceFile, (node) => {
      if (!ts.isIdentifier(node) && !ts.isElementAccessExpression(node)) {
        return;
      }
      const symbol = symbolAt(context, node);
      if (symbol === undefined) {
        return;
      }
      const authority = authorities.get(symbol);
      if (authority === undefined) {
        return;
      }
      if (
        isNodeWithin(node, authority.declaration) ||
        authority.allowedScanBodies.some((scanBody) => isNodeWithin(node, scanBody))
      ) {
        return;
      }
      violations.push(
        makeRecoveryViolation(
          context,
          node,
          symbol,
          'raw-authority: value references are forbidden outside the exact inverse allowlist',
          authority.allowedScanBody,
        ),
      );
    });
  }
}

function collectFactoryCompositionViolations(
  context: RecoveryAnalysisContext,
  inspections: readonly RecoveryFactoryInspection[],
  violations: RecoveryAuthorityViolation[],
): void {
  for (const inspection of inspections) {
    for (const sourceFile of context.productionSourceFiles) {
      const sourcePath = toAnalysisPath(context, sourceFile.fileName);
      visitNodes(sourceFile, (node) => {
        if (!ts.isIdentifier(node) && !ts.isElementAccessExpression(node)) {
          return;
        }
        if (symbolAt(context, node) !== inspection.symbol) {
          return;
        }
        if (isNodeWithin(node, inspection.declaration) || sourcePath === inspection.manifest.compositionSite) {
          return;
        }
        violations.push(
          makeRecoveryViolation(
            context,
            node,
            inspection.symbol,
            'startup-seal: a source factory may be referenced only by its exact composition site',
            inspection.manifest.compositionSite,
          ),
        );
      });
    }
  }
}

function typeSymbol(context: RecoveryAnalysisContext, type: ts.Type): ts.Symbol | undefined {
  return canonicalSymbol(context.checker, type.aliasSymbol ?? type.getSymbol());
}

function typeUsesSymbol(context: RecoveryAnalysisContext, type: ts.Type, expected: ts.Symbol | undefined): boolean {
  if (!expected) {
    return false;
  }
  if (typeSymbol(context, type) === expected) {
    return true;
  }
  return type.isUnionOrIntersection() && type.types.some((member) => typeUsesSymbol(context, member, expected));
}

function startupReachableFiles(context: RecoveryAnalysisContext): Set<string> {
  const roots = RECOVERY_STARTUP_BOUNDARIES.flatMap((entry) =>
    sourceFileAt(context, entry.startupRoot.file) ? [entry.startupRoot.file] : [],
  );
  const targetsBySource = new Map<string, string[]>();
  for (const edge of context.importEdges) {
    const targets = targetsBySource.get(edge.source) ?? [];
    targets.push(edge.target);
    targetsBySource.set(edge.source, targets);
  }

  const reachable = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const target of targetsBySource.get(source) ?? []) {
      if (target.startsWith('src/') && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  return reachable;
}

function collectStartupInputTypeViolations(
  context: RecoveryAnalysisContext,
  violations: RecoveryAuthorityViolation[],
): void {
  const recoverySourceSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'RecoverySource');
  const recoveryPolicySymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'RecoveryPolicy');
  const allowedCapabilitySymbols = context.allowedStartupCapabilities
    .map((capability) => exportedSymbol(context, capability.file, capability.symbol))
    .filter((symbol): symbol is ts.Symbol => symbol !== undefined);

  function validateType(type: ts.Type, location: ts.Node, inputPath: string, seen: Set<ts.Type>): void {
    if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) !== 0) {
      return;
    }
    if (
      typeUsesSymbol(context, type, recoverySourceSymbol) ||
      typeUsesSymbol(context, type, recoveryPolicySymbol) ||
      allowedCapabilitySymbols.some((symbol) => typeUsesSymbol(context, type, symbol))
    ) {
      return;
    }
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) {
        validateType(member, location, inputPath, new Set(seen));
      }
      return;
    }
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      violations.push(
        makeRecoveryViolation(
          context,
          location,
          unresolvedAuthorityDescription(context, location, inputPath),
          `startup-input-seal: unresolved generic input at ${inputPath}`,
          'opaque RecoverySource, RecoveryPolicy, or an exact named settlement capability',
        ),
      );
      return;
    }
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      violations.push(
        makeRecoveryViolation(
          context,
          location,
          unresolvedAuthorityDescription(context, location, inputPath),
          `startup-input-seal: any/unknown input fails closed at ${inputPath}`,
          'opaque RecoverySource, RecoveryPolicy, or an exact named settlement capability',
        ),
      );
      return;
    }
    if (context.checker.isArrayType(type) || context.checker.isTupleType(type)) {
      violations.push(
        makeRecoveryViolation(
          context,
          location,
          unresolvedAuthorityDescription(context, location, inputPath),
          `startup-input-seal: iterable or pre-enumerated input at ${inputPath}`,
          'only the exact registered composite factory accepts readonly RecoveryReceipt<T>[]',
        ),
      );
      return;
    }
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      violations.push(
        makeRecoveryViolation(
          context,
          location,
          unresolvedAuthorityDescription(context, location, inputPath),
          `startup-input-seal: callable or constructor authority at ${inputPath}`,
          'opaque RecoverySource, RecoveryPolicy, or an exact named settlement capability',
        ),
      );
      return;
    }

    const symbolName = typeSymbol(context, type)?.name ?? '';
    if (/(?:Database|Store)$/u.test(symbolName)) {
      violations.push(
        makeRecoveryViolation(
          context,
          location,
          unresolvedAuthorityDescription(context, location, `${inputPath}:${symbolName}`),
          `startup-input-seal: store/database authority at ${inputPath}`,
          'keep broad runtime authority outside the startup slice',
        ),
      );
      return;
    }

    const indexInfos = context.checker.getIndexInfosOfType(type);
    if (indexInfos.length > 0) {
      violations.push(
        makeRecoveryViolation(
          context,
          location,
          unresolvedAuthorityDescription(context, location, inputPath),
          `startup-input-seal: index signatures fail closed at ${inputPath}`,
          'a closed public startup input shape',
        ),
      );
    }
    if (seen.has(type)) {
      return;
    }
    seen.add(type);

    const properties = context.checker.getPropertiesOfType(type);
    if (properties.length === 0 && indexInfos.length === 0) {
      violations.push(
        makeRecoveryViolation(
          context,
          location,
          unresolvedAuthorityDescription(context, location, inputPath),
          `startup-input-seal: unsealed input type at ${inputPath}`,
          'opaque RecoverySource, RecoveryPolicy, or an exact named settlement capability',
        ),
      );
      return;
    }
    for (const property of properties) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
      const propertyType = context.checker.getTypeOfSymbolAtLocation(property, declaration);
      validateType(propertyType, location, `${inputPath}.${property.name}`, seen);
    }
  }

  for (const boundary of RECOVERY_STARTUP_BOUNDARIES) {
    const rootSymbol = exportedSymbol(context, boundary.startupRoot.file, boundary.startupRoot.symbol);
    const declaration = rootSymbol?.valueDeclaration ?? rootSymbol?.declarations?.[0];
    if (!rootSymbol || !declaration) {
      continue;
    }
    const signature = context.checker.getTypeOfSymbolAtLocation(rootSymbol, declaration).getCallSignatures()[0];
    if (!signature) {
      continue;
    }
    for (const parameter of signature.getParameters()) {
      const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration;
      validateType(
        context.checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration),
        parameterDeclaration,
        `${boundary.startupRoot.symbol}.${parameter.name}`,
        new Set(),
      );
    }
  }
}

function expressionContainsOpaqueType(
  context: RecoveryAnalysisContext,
  expression: ts.Expression,
  expectedSymbol: ts.Symbol | undefined,
): boolean {
  let current: ts.Expression = expression;
  while (true) {
    if (typeUsesSymbol(context, context.checker.getTypeAtLocation(current), expectedSymbol)) {
      return true;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return false;
  }
}

function isModuleNamespaceExpression(context: RecoveryAnalysisContext, expression: ts.Expression): boolean {
  const symbol = symbolAt(context, expression);
  return symbol !== undefined && (symbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) !== 0;
}

function collectStartupSliceSyntaxViolations(
  context: RecoveryAnalysisContext,
  violations: RecoveryAuthorityViolation[],
): void {
  const reachable = startupReachableFiles(context);
  const recoverySourceSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'RecoverySource');
  const recoveryReceiptSymbol = exportedSymbol(context, RECOVERY_CONTAINMENT_MODULE, 'RecoveryReceipt');

  for (const sourceFile of context.productionSourceFiles) {
    const sourcePath = toAnalysisPath(context, sourceFile.fileName);
    const isSealedFile =
      reachable.has(sourcePath) || RECOVERY_SOURCE_MATRIX.some((row) => row.sourceModule === sourcePath);
    if (sourcePath === RECOVERY_CONTAINMENT_MODULE) {
      continue;
    }

    visitNodes(sourceFile, (node) => {
      if (
        isSealedFile &&
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))
      ) {
        violations.push(
          makeRecoveryViolation(
            context,
            node,
            unresolvedAuthorityDescription(context, node, 'computed-import'),
            'startup-input-seal: unresolved computed dynamic import fails closed',
            'a statically resolvable startup dependency edge',
          ),
        );
      }

      if (
        isSealedFile &&
        ts.isElementAccessExpression(node) &&
        !ts.isStringLiteralLike(node.argumentExpression) &&
        !ts.isNumericLiteral(node.argumentExpression) &&
        isModuleNamespaceExpression(context, node.expression)
      ) {
        violations.push(
          makeRecoveryViolation(
            context,
            node,
            unresolvedAuthorityDescription(context, node, 'computed-module-element'),
            'startup-input-seal: unresolved computed module element access fails closed',
            'a statically resolved named import',
          ),
        );
      }

      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const assertedType = context.checker.getTypeFromTypeNode(node.type);
        if (typeUsesSymbol(context, assertedType, recoveryReceiptSymbol)) {
          violations.push(
            makeRecoveryViolation(
              context,
              node,
              recoveryReceiptSymbol ?? unresolvedAuthorityDescription(context, node, 'RecoveryReceipt'),
              'startup-input-seal: forged RecoveryReceipt construction is forbidden outside containment.ts',
              RECOVERY_CONTAINMENT_MODULE,
            ),
          );
        }
      }
      if (
        ts.isObjectLiteralExpression(node) &&
        typeUsesSymbol(
          context,
          context.checker.getContextualType(node) ?? context.checker.getTypeAtLocation(node),
          recoveryReceiptSymbol,
        )
      ) {
        violations.push(
          makeRecoveryViolation(
            context,
            node,
            recoveryReceiptSymbol ?? unresolvedAuthorityDescription(context, node, 'RecoveryReceipt'),
            'startup-input-seal: forged RecoveryReceipt construction is forbidden outside containment.ts',
            RECOVERY_CONTAINMENT_MODULE,
          ),
        );
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const propertyName = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : undefined;
        if (expressionContainsOpaqueType(context, node.expression, recoveryReceiptSymbol)) {
          violations.push(
            makeRecoveryViolation(
              context,
              node,
              recoveryReceiptSymbol ?? unresolvedAuthorityDescription(context, node, 'RecoveryReceipt'),
              'startup-input-seal: RecoveryReceipt inspection or unwrapping is forbidden outside containment.ts',
              RECOVERY_CONTAINMENT_MODULE,
            ),
          );
        }
        if (propertyName === 'scan' && expressionContainsOpaqueType(context, node.expression, recoverySourceSymbol)) {
          violations.push(
            makeRecoveryViolation(
              context,
              node,
              recoverySourceSymbol ?? unresolvedAuthorityDescription(context, node, 'RecoverySource'),
              'startup-input-seal: opaque RecoverySource handles expose no scan authority',
              'RecoveryContainment.each(source, policy)',
            ),
          );
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        node.name.elements.some((element) => {
          const propertyName = element.propertyName ?? element.name;
          return ts.isIdentifier(propertyName) && propertyName.text === 'scan';
        }) &&
        expressionContainsOpaqueType(context, node.initializer, recoverySourceSymbol)
      ) {
        violations.push(
          makeRecoveryViolation(
            context,
            node,
            recoverySourceSymbol ?? unresolvedAuthorityDescription(context, node, 'RecoverySource'),
            'startup-input-seal: opaque RecoverySource handles may not be destructured for scan authority',
            'RecoveryContainment.each(source, policy)',
          ),
        );
      }
    });
  }
}

function uniqueRecoveryViolations(violations: readonly RecoveryAuthorityViolation[]): RecoveryAuthorityViolation[] {
  const unique = new Map<string, RecoveryAuthorityViolation>();
  for (const violation of violations) {
    const key = [
      violation.offendingFile,
      violation.authorityDeclaration,
      violation.violatedRule,
      violation.allowedLocation,
    ].join('\n');
    unique.set(key, violation);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.offendingFile}\n${left.violatedRule}\n${left.authorityDeclaration}`;
    const rightKey = `${right.offendingFile}\n${right.violatedRule}\n${right.authorityDeclaration}`;
    return leftKey.localeCompare(rightKey);
  });
}

function analyzeRecoveryAuthorityBoundary(
  context: RecoveryAnalysisContext,
  rules: RecoveryRuleSelection,
): RecoveryAuthorityViolation[] {
  const violations: RecoveryAuthorityViolation[] = [];
  const inspections = inspectRecoveryFactories(context, violations, rules.phase1);

  if (rules.phase1) {
    collectSourceDefinitionImportViolations(context, violations);
    collectRegistryViolations(context, violations);
    collectSourceExportViolations(context, violations);
    collectTestHelperImportViolations(context, violations);
  }
  if (rules.rawAuthority) {
    collectRawAuthorityViolations(context, inspections, violations);
  }
  if (rules.startupInputSeal) {
    collectFactoryCompositionViolations(context, inspections, violations);
    collectStartupInputTypeViolations(context, violations);
    collectStartupSliceSyntaxViolations(context, violations);
  }
  return uniqueRecoveryViolations(violations);
}

const RECOVERY_PRODUCTION_CONTEXT = createRecoveryAnalysisContext(
  RECOVERY_PRODUCTION_PROGRAM,
  REPO_ROOT,
  PARSED_IMPORT_EDGES.map((edge) => ({ source: edge.source, target: edge.target })),
  RECOVERY_STARTUP_CAPABILITIES,
);

function recoveryFixtureContext(fixtureName: 'valid' | 'phase1' | 'raw' | 'startup'): RecoveryAnalysisContext {
  const allowedStartupCapabilities =
    fixtureName === 'valid' || fixtureName === 'startup'
      ? [
          {
            file: 'src/coordinator/startup-recovery.ts',
            symbol: 'NamedSettlementCapability',
          },
        ]
      : [];
  return createRecoveryAnalysisContext(
    RECOVERY_FIXTURE_PROGRAM,
    resolve(RECOVERY_FIXTURE_ROOT, fixtureName),
    undefined,
    allowedStartupCapabilities,
  );
}

const RECOVERY_MUTATION_CASES: readonly {
  readonly mutation: string;
  readonly fixture: 'phase1' | 'raw' | 'startup';
  readonly rules: RecoveryRuleSelection;
  readonly failures: readonly { readonly offendingFile: string; readonly rule: string }[];
}[] = [
  {
    mutation: 'constructor/direct raw-authority import',
    fixture: 'raw',
    rules: { phase1: false, rawAuthority: true, startupInputSeal: false },
    failures: [{ offendingFile: 'src/constructor-import.ts', rule: 'raw-authority:' }],
  },
  {
    mutation: 'source-definition re-export',
    fixture: 'phase1',
    rules: { phase1: true, rawAuthority: false, startupInputSeal: false },
    failures: [
      {
        offendingFile: 'src/coordinator/services/recovery/coordinator-job-source.ts',
        rule: 'may export only its exact named factory',
      },
    ],
  },
  {
    mutation: 'inferred factory with an extra callable property',
    fixture: 'phase1',
    rules: { phase1: true, rawAuthority: false, startupInputSeal: false },
    failures: [
      {
        offendingFile: 'src/discuss/shell/discussion-source-recovery-source.ts',
        rule: 'must be a directly declared function with an explicit RecoverySource',
      },
      {
        offendingFile: 'src/discuss/shell/discussion-source-recovery-source.ts',
        rule: 'factories may not carry extra callable properties',
      },
    ],
  },
  {
    mutation: 'eager enumeration inside a correctly typed factory',
    fixture: 'phase1',
    rules: { phase1: true, rawAuthority: false, startupInputSeal: false },
    failures: [
      {
        offendingFile: 'src/discuss/shell/discussion-candidate-recovery-source.ts',
        rule: 'only inside the registered scan body',
      },
    ],
  },
  {
    mutation: 'renamed import or wrapper closure',
    fixture: 'raw',
    rules: { phase1: false, rawAuthority: true, startupInputSeal: false },
    failures: [{ offendingFile: 'src/renamed-wrapper.ts', rule: 'raw-authority:' }],
  },
  {
    mutation: 'injected dependency property under a domain-shaped interface',
    fixture: 'startup',
    rules: { phase1: false, rawAuthority: false, startupInputSeal: true },
    failures: [
      {
        offendingFile: 'src/coordinator/startup-recovery.ts',
        rule: 'store/database authority',
      },
      {
        offendingFile: 'src/coordinator/startup-recovery.ts',
        rule: 'callable or constructor authority',
      },
      {
        offendingFile: 'src/coordinator/startup-recovery.ts',
        rule: 'unresolved generic input',
      },
      {
        offendingFile: 'src/coordinator/startup-recovery.ts',
        rule: 'index signatures fail closed',
      },
    ],
  },
  {
    mutation: 'unresolved computed edge',
    fixture: 'startup',
    rules: { phase1: false, rawAuthority: false, startupInputSeal: true },
    failures: [
      { offendingFile: 'src/coordinator/computed-edge.ts', rule: 'computed dynamic import' },
      { offendingFile: 'src/coordinator/computed-edge.ts', rule: 'computed module element access' },
    ],
  },
  {
    mutation: 'new unmanifested orchestrator invoking a raw enumerator',
    fixture: 'raw',
    rules: { phase1: false, rawAuthority: true, startupInputSeal: false },
    failures: [{ offendingFile: 'src/unmanifested-orchestrator.ts', rule: 'raw-authority:' }],
  },
  {
    mutation: 'arbitrary pre-enumerated collection passed into a startup slice',
    fixture: 'startup',
    rules: { phase1: false, rawAuthority: false, startupInputSeal: true },
    failures: [
      {
        offendingFile: 'src/coordinator/startup-recovery.ts',
        rule: 'iterable or pre-enumerated input',
      },
    ],
  },
  {
    mutation: 'forged or inspected receipt',
    fixture: 'startup',
    rules: { phase1: false, rawAuthority: false, startupInputSeal: true },
    failures: [
      { offendingFile: 'src/coordinator/receipt-attack.ts', rule: 'forged RecoveryReceipt' },
      { offendingFile: 'src/coordinator/receipt-attack.ts', rule: 'RecoveryReceipt inspection' },
    ],
  },
  {
    mutation: 'production import of a test helper',
    fixture: 'phase1',
    rules: { phase1: true, rawAuthority: false, startupInputSeal: false },
    failures: [{ offendingFile: 'src/orchestrator.ts', rule: 'test code or test helpers' }],
  },
  {
    mutation: 'attempted scan/destructure from an opaque handle',
    fixture: 'startup',
    rules: { phase1: false, rawAuthority: false, startupInputSeal: true },
    failures: [
      {
        offendingFile: 'src/coordinator/startup-recovery.ts',
        rule: 'opaque RecoverySource handles expose no scan authority',
      },
      {
        offendingFile: 'src/coordinator/startup-recovery.ts',
        rule: 'opaque RecoverySource handles may not be destructured',
      },
    ],
  },
  {
    mutation: 'source factory referenced outside its exact composition site',
    fixture: 'startup',
    rules: { phase1: false, rawAuthority: false, startupInputSeal: true },
    failures: [
      {
        offendingFile: 'src/coordinator/rogue-composition.ts',
        rule: 'a source factory may be referenced only by its exact composition site',
      },
    ],
  },
];

describe('recovery authority boundary', () => {
  it('records the exact startup-root and composition-site fixture', () => {
    expect(RECOVERY_STARTUP_BOUNDARIES).toEqual([
      {
        boundary: 'coordinator job recovery',
        startupRoot: {
          file: 'src/coordinator/services/recovery/startup-recovery.ts',
          symbol: 'runCoordinatorJobRecovery',
        },
        compositionSite: 'src/coordinator/services/recovery/index.ts',
      },
      {
        boundary: 'P3 discussion source/candidate',
        startupRoot: {
          file: 'src/discuss/shell/startup-recovery.ts',
          symbol: 'runDiscussionStartupRecovery',
        },
        compositionSite: 'src/discuss/shell/recovery.ts',
      },
      {
        boundary: 'P4 session retention',
        startupRoot: {
          file: 'src/sessions/startup-recovery.ts',
          symbol: 'runSessionStartupRecovery',
        },
        compositionSite: 'src/sessions/lifecycle-reactor.ts',
      },
      {
        boundary: 'P6/P7 workflow',
        startupRoot: {
          file: 'src/workflow/startup-recovery.ts',
          symbol: 'runWorkflowStartupRecovery',
        },
        compositionSite: 'src/workflow/recover.ts',
      },
      {
        boundary: 'AC13 stale-artifact prune',
        startupRoot: {
          file: 'src/coordinator/startup-recovery.ts',
          symbol: 'runStartupStaleArtifactPrune',
        },
        compositionSite: 'src/coordinator/lifecycle.ts',
      },
    ]);
    expect(RECOVERY_SHUTDOWN_BOUNDARIES).toEqual([
      {
        boundary: 'AC13 crashed-job terminalization',
        shutdownRoot: {
          file: 'src/coordinator/shutdown-recovery.ts',
          symbol: 'runShutdownCrashTerminalization',
        },
        compositionSite: 'src/coordinator/lifecycle.ts',
      },
    ]);
    expect(RECOVERY_FATAL_STARTUP_ROOT).toEqual({
      file: 'src/coordinator/index.ts',
      symbol: 'awaitRecoveryCursorBarrier',
    });

    for (const boundary of RECOVERY_STARTUP_BOUNDARIES) {
      expect(sourceFileAt(RECOVERY_PRODUCTION_CONTEXT, boundary.startupRoot.file)).toBeDefined();
      expect(
        exportedSymbol(RECOVERY_PRODUCTION_CONTEXT, boundary.startupRoot.file, boundary.startupRoot.symbol),
      ).toBeDefined();
      expect(sourceFileAt(RECOVERY_PRODUCTION_CONTEXT, boundary.compositionSite)).toBeDefined();
    }
    for (const boundary of RECOVERY_SHUTDOWN_BOUNDARIES) {
      expect(sourceFileAt(RECOVERY_PRODUCTION_CONTEXT, boundary.shutdownRoot.file)).toBeDefined();
      expect(
        exportedSymbol(RECOVERY_PRODUCTION_CONTEXT, boundary.shutdownRoot.file, boundary.shutdownRoot.symbol),
      ).toBeDefined();
      expect(sourceFileAt(RECOVERY_PRODUCTION_CONTEXT, boundary.compositionSite)).toBeDefined();
    }
    expect(
      exportedSymbol(RECOVERY_PRODUCTION_CONTEXT, RECOVERY_FATAL_STARTUP_ROOT.file, RECOVERY_FATAL_STARTUP_ROOT.symbol),
    ).toBeDefined();
  });

  it('derives exact factory and raw-authority sets from the canonical source matrix', () => {
    expect(RECOVERY_SOURCE_FACTORIES.map((factory) => factory.name)).toEqual([
      'coordinatorJobRecoverySource',
      'discussionSourceRecoverySource',
      'discussionCandidateRecoverySource',
      'sessionProjectionRecoverySource',
      'sessionContinuationLeaseRecoverySource',
      'terminalRetentionOutcomeRecoverySource',
      'retentionReleasePairComponentSource',
      'retentionWorkItemRecoverySource',
      'workflowRecoverySource',
      'staleJobCleanupSource',
      'crashedJobTerminalizationSource',
    ]);
    expect(RECOVERY_RAW_AUTHORITIES.map((authority) => authority.name)).toEqual([
      'scanCoordinatorJobRecoveryEnvelopes',
      'scanDiscussionSourceRows',
      'scanDiscussionCandidateEnvelopes',
      'scanSessionProjectionRows',
      'scanPendingContinuationLeaseRows',
      'scanTerminalRetentionOutcomeRows',
      'scanRetentionReleaseAndTerminalRows',
      'scanRetentionWorkRows',
      'composeRetentionWorkItemReceipts',
      'scanWorkflowRecoveryEnvelopes',
      'scanStaleJobCleanupRows',
      'scanCrashedJobRows',
    ]);

    for (const factory of RECOVERY_SOURCE_FACTORIES) {
      const factorySymbol = exportedSymbol(RECOVERY_PRODUCTION_CONTEXT, factory.module, factory.name);
      const compositionSite = sourceFileAt(RECOVERY_PRODUCTION_CONTEXT, factory.compositionSite);
      expect(factorySymbol, `${factory.name} must resolve to its canonical declaration`).toBeDefined();
      expect(compositionSite, `${factory.compositionSite} must resolve as a composition site`).toBeDefined();

      let referencedAtCompositionSite = false;
      if (factorySymbol && compositionSite) {
        visitNodes(compositionSite, (node) => {
          if (
            (ts.isIdentifier(node) || ts.isElementAccessExpression(node)) &&
            symbolAt(RECOVERY_PRODUCTION_CONTEXT, node) === factorySymbol
          ) {
            referencedAtCompositionSite = true;
          }
        });
      }
      expect(referencedAtCompositionSite, `${factory.name} must be referenced by ${factory.compositionSite}`).toBe(
        true,
      );
    }

    for (const authority of RECOVERY_RAW_AUTHORITIES) {
      expect(
        topLevelDeclarationSymbol(RECOVERY_PRODUCTION_CONTEXT, authority.module, authority.name),
        `${authority.name} must resolve to its canonical raw-authority declaration`,
      ).toBeDefined();
    }

    for (const capability of RECOVERY_STARTUP_CAPABILITIES) {
      expect(
        exportedSymbol(RECOVERY_PRODUCTION_CONTEXT, capability.file, capability.symbol),
        `${capability.symbol} must resolve to its named settlement capability`,
      ).toBeDefined();
    }
  });

  it('enforces the complete recovery authority seal against production', () => {
    const violations = analyzeRecoveryAuthorityBoundary(RECOVERY_PRODUCTION_CONTEXT, {
      phase1: true,
      rawAuthority: true,
      startupInputSeal: true,
    });
    assertNoRecoveryViolations(violations);
    // Type-aware whole-program analysis over every production source, so this budget is hardware-bound
    // rather than a hang signal — CI runners take roughly 6x a dev machine, and the previous 30s turned
    // that into a failure that read like a violation. Measured locally: startup-input seal ~4.8s
    // (type expansion), phase 1 ~2.9s, raw authority ~0.4s.
  }, 120_000);

  it('accepts a fully sealed synthetic source, composite, and startup surface', () => {
    const violations = analyzeRecoveryAuthorityBoundary(recoveryFixtureContext('valid'), {
      phase1: true,
      rawAuthority: true,
      startupInputSeal: true,
    });
    assertNoRecoveryViolations(violations);
  });

  it('rejects Phase 1 source-module, registry, explicit-return, and lazy-factory mutations', () => {
    const violations = analyzeRecoveryAuthorityBoundary(recoveryFixtureContext('phase1'), {
      phase1: true,
      rawAuthority: false,
      startupInputSeal: false,
    });
    const rules = violations.map((violation) => violation.violatedRule);

    expect(rules.some((rule) => rule.startsWith('source-module: recovery source definitions'))).toBe(true);
    expect(rules.some((rule) => rule.startsWith('registry:'))).toBe(true);
    expect(rules.some((rule) => rule.startsWith('explicit-return:'))).toBe(true);
    expect(rules.some((rule) => rule.startsWith('lazy-factory:'))).toBe(true);
    expect(rules.some((rule) => rule.includes('test code or test helpers'))).toBe(true);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          offendingFile: 'src/coordinator/services/recovery/coordinator-job-source.ts',
          violatedRule: expect.stringContaining('may export only its exact named factory'),
        }),
        expect.objectContaining({
          offendingFile: 'src/discuss/shell/discussion-source-recovery-source.ts',
          violatedRule: expect.stringContaining('directly declared function with an explicit RecoverySource'),
        }),
        expect.objectContaining({
          offendingFile: 'src/discuss/shell/discussion-source-recovery-source.ts',
          violatedRule: expect.stringContaining('extra callable properties'),
        }),
        expect.objectContaining({
          offendingFile: 'src/discuss/shell/discussion-candidate-recovery-source.ts',
          violatedRule: expect.stringContaining('only inside the registered scan body'),
        }),
        expect.objectContaining({
          offendingFile: 'src/sessions/projection-recovery-source.ts',
          violatedRule: expect.stringContaining('pre-enumerated result'),
        }),
      ]),
    );
    expect(formatRecoveryViolations(violations)).toContain('Dependency path:');
    expect(formatRecoveryViolations(violations)).toContain('Allowed source scan body or composition site:');
  });

  it.each(RECOVERY_MUTATION_CASES)('rejects $mutation', ({ mutation, fixture, rules, failures }) => {
    const violations = analyzeRecoveryAuthorityBoundary(recoveryFixtureContext(fixture), rules);

    for (const failure of failures) {
      assertRecoveryMutationFailure(mutation, violations, failure);
    }
  });

  it('lets broad coordinator and LifecycleReactor runtime database/store authority stay outside startup inputs', () => {
    const context = recoveryFixtureContext('valid');
    const violations = analyzeRecoveryAuthorityBoundary(context, {
      phase1: true,
      rawAuthority: true,
      startupInputSeal: true,
    });
    assertNoRecoveryViolations(violations);

    const reachable = startupReachableFiles(context);
    expect(reachable).toContain('src/coordinator/startup-recovery.ts');
    expect(reachable).not.toContain('src/coordinator/index.ts');
    expect(reachable).not.toContain('src/sessions/lifecycle-reactor.ts');
    expect(sourceFileAt(context, 'src/coordinator/index.ts')).toBeDefined();
    expect(sourceFileAt(context, 'src/sessions/lifecycle-reactor.ts')).toBeDefined();
  });
});
