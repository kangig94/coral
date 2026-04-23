/*
Architectural boundary guard for seams established by:
- e34d8d8: workflow/ may depend on provider discovery only through src/providers/catalog.ts, not provider implementations or provider internals.
This test enforces those boundaries with the TypeScript compiler API and treats import type, export ... from, typeof import('...'), and relative dynamic import('...') as boundary-crossing imports.
Known non-goals: computed import(variableName) and relative require('...') are intentionally not covered.
*/

// Phase 1 decision: extracted shared scanning helpers to src/__tests__/__helpers__/ts-import-scanner.ts because the reused resolver and AST import scanner exceed the inline duplication threshold.
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createProductionFileIndex,
  listProductionSourceFiles,
  parseSourceImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from './__helpers__/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const SRC_ROOT = resolve(dirname(__filename), '..');
const REPO_ROOT = resolve(SRC_ROOT, '..');

const WORKFLOW_ROOT = 'src/workflow';
const JOBS_ROOT = 'src/jobs';
const KB_ROOT = 'src/kb';
const COORDINATOR_ROOT = 'src/coordinator';
const CLIENT_ROOT = ['src', 'client'].join('/');
const SKILLS_ROOT = ['src', 'skills'].join('/');
const SHARED_ROOT = ['src', 'shared'].join('/');
const RETIRED_KB_API = ['src', 'kb', 'api.ts'].join('/');
const RETIRED_JOBS_VIEWS = ['src', 'jobs', 'views.ts'].join('/');
const RETIRED_PROVIDERS_API = ['src', 'providers', 'api.ts'].join('/');
const RETIRED_HTTP_CLIENT = ['src', 'transport', 'http', 'http-client.ts'].join('/');
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
const RETIRED_REQUEST_CONTEXT = ['src', 'infra', 'request-context.ts'].join('/');
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
const RETIRED_DISCUSS_STATE_HELPERS = ['src', 'discuss', 'state-helpers.ts'].join('/');
const RETIRED_HTTP_BACKEND_HELPERS = ['src', 'transport', 'http', 'backend-helpers.ts'].join('/');
const RETIRED_KB_MUTATION_HELPERS = ['src', 'kb', 'corpus', 'mutation-helpers.ts'].join('/');
const RETIRED_COMMAND_HELPERS = ['src', 'cli', 'command-helpers.ts'].join('/');
const RETIRED_STORE_KB_QUERIES = ['src', 'store', 'queries', 'kb.ts'].join('/');
const RETIRED_STORE_CORPUS_STATE = ['src', 'store', 'corpus-state.ts'].join('/');
const RETIRED_COORDINATOR_SHIMS = [
  ['src', 'coordinator', 'discovery.ts'].join('/'),
  ['src', 'coordinator', 'paths.ts'].join('/'),
  ['src', 'coordinator', 'equipment', 'contract.ts'].join('/'),
  ['src', 'coordinator', 'composition', 'recovery-registry.ts'].join('/'),
] as const;
const PROVIDERS_ROOT = 'src/providers';
const WORKFLOW_PROVIDER_ALLOWLIST_TARGET = 'src/providers/catalog.ts';

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
  it('kb/ may not import coordinator/ implementation modules', () => {
    const violations = collectViolations(
      KB_ROOT,
      'kb/ must stay coordinator-free',
      'move the shared contract into kb/, store/, runtime/, or another lower-level owner instead.',
      (target) => isWithinPath(target, COORDINATOR_ROOT),
    );

    assertNoViolations(violations);
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
  it('the retired request-context owner must remain deleted', () => {
    expect(PRODUCTION_SOURCE_FILES).not.toContain(RETIRED_REQUEST_CONTEXT);
    expect(existsSync(resolve(REPO_ROOT, RETIRED_REQUEST_CONTEXT))).toBe(false);
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
      RETIRED_DISCUSS_STATE_HELPERS,
      RETIRED_HTTP_BACKEND_HELPERS,
      RETIRED_KB_MUTATION_HELPERS,
      RETIRED_COMMAND_HELPERS,
      RETIRED_STORE_KB_QUERIES,
      RETIRED_STORE_CORPUS_STATE,
    ]) {
      expect(PRODUCTION_SOURCE_FILES).not.toContain(retiredPath);
      expect(existsSync(resolve(REPO_ROOT, retiredPath))).toBe(false);
    }
  });
  it('store schema no longer contains projection_kb residue', () => {
    const schemaSql = readFileSync(resolve(REPO_ROOT, 'src/store/schema.sql'), 'utf8');
    const initialMigration = readFileSync(resolve(REPO_ROOT, 'src/store/migrations/001_initial.sql'), 'utf8');

    expect(schemaSql).not.toContain('projection_kb');
    expect(initialMigration).not.toContain('projection_kb');
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
