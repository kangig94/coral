import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');
const COORDINATOR_ROOT = join(REPO_ROOT, 'src', 'coordinator');
const ALL_PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const COORDINATOR_FILE_PATHS = listProductionSourceFiles(COORDINATOR_ROOT);
const COORDINATOR_FILES = COORDINATOR_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath));
const COORDINATOR_FILE_SET = new Set(COORDINATOR_FILES);
const COORDINATOR_EDGES = parseProductionImportEdges(REPO_ROOT, COORDINATOR_FILE_PATHS, ALL_PRODUCTION_FILE_PATHS);

const EXPECTED_COORDINATOR_FILES = new Set([
  'src/coordinator/bootstrap.ts',
  'src/coordinator/composition/backend-control.ts',
  'src/coordinator/composition/backend-core-types.ts',
  'src/coordinator/composition/backend-defaults.ts',
  'src/coordinator/composition/backend-world.ts',
  'src/coordinator/composition/create-backend-core.ts',
  'src/coordinator/composition/execution-services.ts',
  'src/coordinator/consumer-driver.ts',
  'src/coordinator/contracts.ts',
  'src/coordinator/control.ts',
  'src/coordinator/coordinator.ts',
  'src/coordinator/corpus-notify.ts',
  'src/coordinator/discovery-api.ts',
  'src/coordinator/equipment/lifecycle.ts',
  'src/coordinator/equipment/rpc.ts',
  'src/coordinator/equipment/runtime-activation.ts',
  'src/coordinator/equipment/slots.ts',
  'src/coordinator/event-bus.ts',
  'src/coordinator/execution-service.ts',
  'src/coordinator/invocation-scope.ts',
  'src/coordinator/live/admission.ts',
  'src/coordinator/live/curate-scheduler.ts',
  'src/coordinator/live/durable-transport.ts',
  'src/coordinator/live/idle.ts',
  'src/coordinator/live/provider-hosts/drain.ts',
  'src/coordinator/live/provider-hosts/idle.ts',
  'src/coordinator/live/provider-hosts/lease.ts',
  'src/coordinator/live/provider-hosts/pool.ts',
  'src/coordinator/live/provider-hosts/recovery.ts',
  'src/coordinator/live/provider-hosts/state.ts',
  'src/coordinator/live/worker-limits.ts',
  'src/coordinator/lock.ts',
  'src/coordinator/ownership-checker.ts',
  'src/coordinator/recording/observer.ts',
  'src/coordinator/services/execution-policies.ts',
  'src/coordinator/services/job-abort-service.ts',
  'src/coordinator/services/job-launch-service.ts',
  'src/coordinator/services/job-wait-service.ts',
  'src/coordinator/services/kb-reindex-service.ts',
  'src/coordinator/services/kb-source-import-service.ts',
  'src/coordinator/services/recovery-actions.ts',
  'src/coordinator/services/recovery-coordinator.ts',
  'src/coordinator/services/recovery-service.ts',
  'src/coordinator/services/recovery-snapshot.ts',
  'src/coordinator/services/workflow-execution-service.ts',
  'src/coordinator/shutdown/mode.ts',
  'src/coordinator/shutdown/sequence.ts',
  'src/coordinator/workflow-cleanup.ts',
]);

const DOMAIN_API_TARGETS = new Set<string>();
const CONTRACT_TARGETS = new Set([
  'src/jobs/admission-contract.ts',
  'src/kb/contracts.ts',
  'src/kb/state/corpus-state.ts',
  'src/kb/search/contract.ts',
  'src/providers/contract.ts',
  'src/providers/registry.ts',
]);
const TRANSPORT_TARGETS = new Set([
  'src/transport/ipc/server.ts',
]);
const COORDINATOR_GLUE_SOURCES = new Set([
  'src/coordinator/coordinator.ts',
  'src/coordinator/bootstrap.ts',
  'src/coordinator/contracts.ts',
  'src/coordinator/control.ts',
  'src/coordinator/event-bus.ts',
  'src/coordinator/execution-service.ts',
  'src/coordinator/workflow-cleanup.ts',
  'src/coordinator/shutdown/sequence.ts',
  'src/coordinator/live/curate-scheduler.ts',
  'src/coordinator/live/durable-transport.ts',
]);

const BROAD_IMPORT_PREFIXES = [
  'src/coordinator/composition/',
  'src/coordinator/equipment/',
  'src/coordinator/services/',
] as const;
const FORBIDDEN_PREFIXES = [
  'src/execution/',
  'src/jobs/shell/',
  'src/sessions/shell/',
  'src/discuss/shell/',
  'src/workflow/recover.ts',
  'src/jobs/reconcile/',
] as const;

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isBroadImportSource(source: string): boolean {
  return COORDINATOR_GLUE_SOURCES.has(source) || startsWithAny(source, BROAD_IMPORT_PREFIXES);
}

describe('coordinator topology invariants', () => {
  it('matches the expected production coordinator module set', () => {
    expect(new Set(COORDINATOR_FILES)).toEqual(EXPECTED_COORDINATOR_FILES);
  });

  it('contains no forbidden coordinator extras', () => {
    expect(COORDINATOR_FILE_SET.has('src/coordinator/contracts.ts')).toBe(true);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/event-bus.ts')).toBe(true);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/execution-service.ts')).toBe(true);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/workflow-cleanup.ts')).toBe(true);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/live/discuss-runtime.ts')).toBe(false);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/info.ts')).toBe(false);
  });

  it('keeps non-exempt coordinator files on coordinator/store/runtime/infra/api seams', () => {
    const violations = COORDINATOR_EDGES.filter(({ source, target }) => {
      if (isBroadImportSource(source)) {
        return false;
      }

      if (
        target.startsWith('src/coordinator/')
        || target.startsWith('src/store/')
        || target.startsWith('src/runtime/')
        || target.startsWith('src/infra/')
      ) {
        return false;
      }

      if (DOMAIN_API_TARGETS.has(target)) {
        return false;
      }

      if (CONTRACT_TARGETS.has(target)) {
        return false;
      }

      if (TRANSPORT_TARGETS.has(target)) {
        return false;
      }

      return target.startsWith('src/');
    }).map(({ source, target }) => `${source} -> ${target}`);

    expect(violations).toEqual([]);
  });

  it('forbids retired execution imports and shell/reconcile reach-through outside exempt glue', () => {
    const violations = COORDINATOR_EDGES.filter(({ source, target }) => {
      if (target.startsWith('src/execution/')) {
        return true;
      }
      if (isBroadImportSource(source)) {
        return false;
      }
      return startsWithAny(target, FORBIDDEN_PREFIXES);
    }).map(({ source, target }) => `${source} -> ${target}`);

    expect(violations).toEqual([]);
  });
});
