import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '../__helpers__/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const PRODUCTION_FILES = new Set(PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath)));
const IMPORT_EDGES = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILE_PATHS);

const DOMAIN_ROOTS = [
  'src/jobs/',
  'src/sessions/',
  'src/discuss/',
  'src/workflow/',
  'src/kb/',
  'src/simulation/',
  'src/providers/',
  'src/expansion/',
] as const;
const RUNTIME_INFRA_FORBIDDEN = [...DOMAIN_ROOTS, 'src/transport/', 'src/coordinator/', 'src/cli/'] as const;
const TRANSPORT_ALLOWED = new Set([
  'src/jobs/api.ts',
  'src/jobs/abort-result.ts',
  'src/jobs/launch.ts',
  'src/jobs/phase.ts',
  'src/jobs/records.ts',
  'src/jobs/wait.ts',
  'src/jobs/wait-stream-event.ts',
  'src/sessions/api.ts',
  'src/discuss/command-schemas.ts',
  'src/discuss/read-contract.ts',
  'src/discuss/session-types.ts',
  'src/discuss/watch.ts',
  'src/workflow/api.ts',
  'src/workflow/input.ts',
  'src/kb/entry-types.ts',
  'src/kb/result.ts',
  'src/kb/tool-contracts.ts',
  'src/kb/read-contract.ts',
  'src/expansion/equipment-contract.ts',
  'src/providers/request-policy.ts',
]);
const COORDINATOR_GLUE_EXEMPT = new Set([
  'src/coordinator/coordinator.ts',
  'src/coordinator/bootstrap.ts',
  'src/coordinator/api.ts',
  'src/coordinator/contracts.ts',
  'src/coordinator/control.ts',
  'src/coordinator/event-bus.ts',
  'src/coordinator/execution-service.ts',
  'src/coordinator/workflow-cleanup.ts',
  'src/coordinator/shutdown/sequence.ts',
  'src/coordinator/live/curate-scheduler.ts',
  'src/coordinator/live/durable-transport.ts',
]);
const COORDINATOR_EXEMPT_PREFIXES = [
  'src/coordinator/composition/',
  'src/coordinator/equipment/',
  'src/coordinator/services/',
] as const;
const COORDINATOR_ALLOWED = new Set([
  'src/jobs/api.ts',
  'src/sessions/api.ts',
  'src/workflow/api.ts',
  'src/kb/contracts.ts',
  'src/kb/state/corpus-state.ts',
  'src/providers/contract.ts',
  'src/providers/registry.ts',
]);
const GENERIC_FILENAMES = ['utils.ts', 'types.ts', 'schemas.ts', 'shared.ts', 'shared-utils.ts'] as const;
const DOMAIN_ROOT_DIRS = [
  'src/jobs',
  'src/sessions',
  'src/discuss',
  'src/workflow',
  'src/kb',
  'src/simulation',
  'src/providers',
  'src/expansion',
] as const;

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function collectViolations(predicate: (source: string, target: string) => boolean): string[] {
  return IMPORT_EDGES.filter(({ source, target }) => predicate(source, target)).map(({ source, target }) => `${source} -> ${target}`);
}

describe('architecture layering invariants (architecture §16, #27-#31)', () => {
  it('#27: runtime and infra import nothing from domains, transport, coordinator, or cli', () => {
    const violations = collectViolations(
      (source, target) =>
        (source.startsWith('src/runtime/') || source.startsWith('src/infra/')) &&
        startsWithAny(target, RUNTIME_INFRA_FORBIDDEN),
    );

    expect(violations).toEqual([]);
  });

  it('#28: transport imports only transport-local helpers and named domain public contracts', () => {
    const violations = collectViolations((source, target) => {
      if (!source.startsWith('src/transport/')) {
        return false;
      }

      if (
        target.startsWith('src/transport/')
        || target.startsWith('src/runtime/')
        || target.startsWith('src/infra/')
      ) {
        return false;
      }

      if (TRANSPORT_ALLOWED.has(target)) {
        return false;
      }

      return startsWithAny(target, DOMAIN_ROOTS) || target.startsWith('src/coordinator/');
    });

    expect(violations).toEqual([]);
  });

  it('#29: only coordinator glue and extracted coordinator implementation leafs may bypass coordinator contract entrypoints', () => {
    const violations = collectViolations((source, target) => {
      if (
        !source.startsWith('src/coordinator/') ||
        COORDINATOR_GLUE_EXEMPT.has(source) ||
        startsWithAny(source, COORDINATOR_EXEMPT_PREFIXES)
      ) {
        return false;
      }

      if (
        target.startsWith('src/coordinator/')
        || target.startsWith('src/runtime/')
        || target.startsWith('src/infra/')
        || target.startsWith('src/store/')
      ) {
        return false;
      }

      if (COORDINATOR_ALLOWED.has(target)) {
        return false;
      }

      return startsWithAny(target, DOMAIN_ROOTS);
    });

    expect(violations).toEqual([]);
  });

  it('#30: production files never import src/testing', () => {
    const violations = collectViolations(
      (source, target) => !source.startsWith('src/testing/') && target.startsWith('src/testing/'),
    );

    expect(violations).toEqual([]);
  });

  it('kb tool contracts stay on the transport and kb tool-handler seams', () => {
    const violations = collectViolations(
      (source, target) =>
        target === 'src/kb/tool-contracts.ts' &&
        !source.startsWith('src/transport/') &&
        source !== 'src/kb/tool-handlers.ts',
    );

    expect(violations).toEqual([]);
  });

  it('kb domain does not import transport-owned result wrappers', () => {
    const violations = collectViolations(
      (source, target) => source.startsWith('src/kb/') && target === 'src/transport/tool-result.ts',
    );

    expect(violations).toEqual([]);
  });

  it('#31: domain roots do not contain generic filenames', () => {
    const banned = DOMAIN_ROOT_DIRS.flatMap((root) =>
      GENERIC_FILENAMES.map((name) => `${root}/${name}`).filter((filePath) => PRODUCTION_FILES.has(filePath)),
    );

    expect(banned).toEqual([]);
  });
});
