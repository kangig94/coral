import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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
  'src/coordinator/bootstrap-diagnostics.ts',
  'src/coordinator/bootstrap.ts',
  'src/coordinator/child-principal-registry.ts',
  'src/coordinator/composition/job-control.ts',
  'src/coordinator/composition/store-services-ref.ts',
  'src/coordinator/composition/types.ts',
  'src/coordinator/composition/defaults.ts',
  'src/coordinator/composition/world.ts',
  'src/coordinator/composition/index.ts',
  'src/coordinator/composition/execution-services.ts',
  'src/coordinator/contracts.ts',
  'src/coordinator/lifecycle.ts',
  'src/coordinator/index.ts',
  'src/coordinator/event-bus.ts',
  'src/coordinator/execution-service.ts',
  'src/coordinator/handoff.ts',
  'src/coordinator/invocation-scope.ts',
  'src/coordinator/runtime-components/kb-health-component.ts',
  'src/coordinator/live/kb-daemon-supervisor.ts',
  'src/coordinator/live/admission.ts',
  'src/coordinator/live/durable-transport.ts',
  'src/coordinator/live/idle.ts',
  'src/coordinator/live/process-supervision.ts',
  'src/coordinator/live/provider-server-transport.ts',
  'src/coordinator/live/provider-hosts/drain.ts',
  'src/coordinator/live/provider-hosts/idle.ts',
  'src/coordinator/live/provider-hosts/index.ts',
  'src/coordinator/live/provider-hosts/lease.ts',
  'src/coordinator/live/provider-hosts/recovery.ts',
  'src/coordinator/live/provider-hosts/state.ts',
  'src/coordinator/live/worker-limits.ts',
  'src/coordinator/spawn-observer.ts',
  'src/coordinator/ownership-checker.ts',
  'src/coordinator/services/execution-policies.ts',
  'src/coordinator/services/job-abort.ts',
  'src/coordinator/services/job-launch.ts',
  'src/coordinator/services/job-wait.ts',
  'src/coordinator/services/kb-curate-assistant.ts',
  'src/coordinator/runtime-components/contract.ts',
  'src/coordinator/runtime-components/registry.ts',
  'src/coordinator/services/recovery/actions.ts',
  'src/coordinator/services/recovery/authority-snapshot.ts',
  'src/coordinator/services/recovery/index.ts',
  'src/coordinator/services/recovery/service.ts',
  'src/coordinator/services/recovery/snapshot.ts',
  'src/coordinator/services/terminal-materializer.ts',
  'src/coordinator/services/workflow-execution.ts',
  'src/coordinator/services/workflow-finalization.ts',
  'src/coordinator/services/workflow-recovery-finalizer.ts',
  'src/coordinator/shutdown.ts',
]);

const DOMAIN_API_TARGETS = new Set<string>();
// Domain files coordinator may reach into. The set is intentionally small —
// each entry names a *contract-shaped* file the domain exposes to outside
// callers (ports, schemas, config types, projection inputs, etc.). It is
// NOT an artificial seam: types live at their conceptual home, and this
// list just enumerates which domain files are public surface.
const CONTRACT_TARGETS = new Set([
  'src/jobs/contracts/admission.ts',
  'src/jobs/launch.ts',
  'src/jobs/outcome.ts',
  'src/kb/contract.ts',
  'src/kb/state/corpus-state.ts',
  'src/kb/search/contract.ts',
  'src/kb/projection-input-contract.ts',
  'src/providers/contract.ts',
  'src/providers/protocol.ts',
  'src/providers/registry.ts',
  'src/sessions/continuity.ts',
  'src/store/consumer-contract.ts',
]);
const TRANSPORT_TARGETS = new Set([
  'src/transport/ipc/server.ts',
  'src/transport/ipc/handoff.ts',
  'src/transport/ipc/client.ts',
]);
const COORDINATOR_GLUE_SOURCES = new Set([
  'src/coordinator/index.ts',
  'src/coordinator/bootstrap.ts',
  'src/coordinator/contracts.ts',
  'src/coordinator/lifecycle.ts',
  'src/coordinator/event-bus.ts',
  'src/coordinator/execution-service.ts',
  'src/coordinator/shutdown.ts',
  'src/coordinator/live/durable-transport.ts',
  'src/coordinator/live/kb-daemon-supervisor.ts',
]);

const BROAD_IMPORT_PREFIXES = [
  'src/coordinator/composition/',
  'src/coordinator/services/',
  'src/coordinator/runtime-components/',
] as const;
const FORBIDDEN_PREFIXES = [
  'src/execution/',
  'src/jobs/shell/',
  'src/sessions/shell/',
  'src/discuss/shell/',
  'src/workflow/recover.ts',
  'src/jobs/reconcile/',
] as const;
const KB_RUNTIME_IMPLEMENTATION_TARGETS = new Set(['src/kb/runtime.ts', 'src/kb/runtime-contract.ts']);
const KB_DAEMON_IMPLEMENTATION_TARGETS = new Set([
  'src/kb-daemon/daemon-main.ts',
  'src/kb-daemon/request-service.ts',
  'src/kb-daemon/runtime-host.ts',
]);
const KB_DAEMON_IMPLEMENTATION_PREFIXES = ['src/kb-daemon/expansion/', 'src/kb-daemon/services/'] as const;
const PROVIDER_IMPLEMENTATION_PREFIXES = ['src/providers/claude/', 'src/providers/codex/'] as const;

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isBroadImportSource(source: string): boolean {
  return COORDINATOR_GLUE_SOURCES.has(source) || startsWithAny(source, BROAD_IMPORT_PREFIXES);
}

function isKbDaemonOwnedSource(source: string): boolean {
  return source.startsWith('src/kb-daemon/');
}

describe('coordinator topology invariants', () => {
  it('matches the expected production coordinator module set', () => {
    expect(new Set(COORDINATOR_FILES)).toEqual(EXPECTED_COORDINATOR_FILES);
  });

  it('contains no forbidden coordinator extras', () => {
    expect(COORDINATOR_FILE_SET.has('src/coordinator/contracts.ts')).toBe(true);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/event-bus.ts')).toBe(true);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/execution-service.ts')).toBe(true);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/live/discuss-runtime.ts')).toBe(false);
    expect(COORDINATOR_FILE_SET.has('src/coordinator/info.ts')).toBe(false);
  });

  it('keeps non-exempt coordinator files on coordinator/store/runtime/infra/api seams', () => {
    const violations = COORDINATOR_EDGES.filter(({ source, target }) => {
      if (isBroadImportSource(source)) {
        return false;
      }

      if (
        target.startsWith('src/coordinator/') ||
        target.startsWith('src/store/') ||
        target.startsWith('src/runtime/') ||
        target.startsWith('src/infra/') ||
        target.startsWith('src/security/')
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

  it('keeps daemon-owned KB runtime modules out of parent coordinator wiring', () => {
    const violations = COORDINATOR_EDGES.filter(({ source, target }) => {
      if (isKbDaemonOwnedSource(source)) {
        return false;
      }
      if (source === 'src/coordinator/bootstrap.ts' && target === 'src/kb-daemon/daemon-main.ts') {
        return false;
      }
      return (
        KB_RUNTIME_IMPLEMENTATION_TARGETS.has(target) ||
        KB_DAEMON_IMPLEMENTATION_TARGETS.has(target) ||
        startsWithAny(target, KB_DAEMON_IMPLEMENTATION_PREFIXES)
      );
    }).map(({ source, target }) => `${source} -> ${target}`);

    expect(violations).toEqual([]);
  });

  it('keeps KB curation on the opaque bound-provider capability', () => {
    const violations = COORDINATOR_EDGES.filter(({ source, target }) => {
      if (source !== 'src/coordinator/services/kb-curate-assistant.ts') return false;
      return target === 'src/providers/execution-context.ts' || startsWithAny(target, PROVIDER_IMPLEMENTATION_PREFIXES);
    }).map(({ source, target }) => `${source} -> ${target}`);

    expect(violations).toEqual([]);
    const source = readFileSync(join(REPO_ROOT, 'src/coordinator/services/kb-curate-assistant.ts'), 'utf8');
    expect(source).not.toMatch(/\bcredentialSource\s*\(/u);
  });
});
