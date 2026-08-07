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
/** Every canonical `src/...` path that exists, for the self-checks below: a forbidden or allowed entry that
 *  matches nothing here silently narrows or dead-weights the rule it names, in exactly the shape this repo's
 *  review round exists to eliminate — see `no-carrier-observation-in-action-paths.test.ts`'s identical use. */
const ALL_CANONICAL_FILES = new Set(
  ALL_PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath)),
);
/** Import edges sourced from anywhere in `src/`, not only from `coordinator/`: `CONTRACT_TARGETS` and
 *  `TRANSPORT_TARGETS` name domain-owned public surface, so whether they are live is a question about who
 *  imports them at all, not only whether coordinator currently does. */
const ALL_EDGES = parseProductionImportEdges(REPO_ROOT, ALL_PRODUCTION_FILE_PATHS);

/** A directory root matches by prefix, a file entry by identity — mirrors `unmatchedRoots` in
 *  `no-carrier-observation-in-action-paths.test.ts`. */
function referencesRealPath(entry: string, canonicalFiles: ReadonlySet<string>): boolean {
  return entry.endsWith('/') ? [...canonicalFiles].some((file) => file.startsWith(entry)) : canonicalFiles.has(entry);
}

const EXPECTED_COORDINATOR_FILES = new Set([
  'src/coordinator/bootstrap-diagnostics.ts',
  'src/coordinator/bootstrap.ts',
  'src/coordinator/child-principal-registry.ts',
  'src/coordinator/composition/carrier-observation.ts',
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
  'src/coordinator/handoff-runner.ts',
  'src/coordinator/handoff.ts',
  'src/coordinator/invocation-scope.ts',
  'src/coordinator/runtime-components/kb-health-component.ts',
  'src/coordinator/runtime-components/recovery-component.ts',
  'src/coordinator/live/kb-daemon-supervisor.ts',
  'src/coordinator/live/admission.ts',
  'src/coordinator/live/durable-transport.ts',
  'src/coordinator/live/idle.ts',
  'src/coordinator/live/provider-proxy/acquisition-steps.ts',
  'src/coordinator/live/provider-proxy/authority.ts',
  'src/coordinator/live/provider-proxy/heartbeat.ts',
  'src/coordinator/live/provider-proxy/index.ts',
  'src/coordinator/live/provider-proxy/operation-route.ts',
  'src/coordinator/live/provider-proxy/role-control.ts',
  'src/coordinator/live/provider-proxy/set-authority.ts',
  'src/coordinator/live/provider-proxy/spawn-undo.ts',
  'src/coordinator/live/provider-hosts/drain.ts',
  'src/coordinator/live/provider-hosts/idle.ts',
  'src/coordinator/live/provider-hosts/index.ts',
  'src/coordinator/live/provider-hosts/lease.ts',
  'src/coordinator/live/provider-hosts/proxy-set-acquisition.ts',
  'src/coordinator/live/provider-hosts/recovery.ts',
  'src/coordinator/live/provider-hosts/state.ts',
  'src/coordinator/live/worker-limits.ts',
  'src/coordinator/spawn-observer.ts',
  'src/coordinator/shutdown-recovery.ts',
  'src/coordinator/startup-recovery.ts',
  'src/coordinator/ownership-checker.ts',
  'src/coordinator/services/execution-policies.ts',
  'src/coordinator/services/job-abort.ts',
  'src/coordinator/services/job-launch.ts',
  'src/coordinator/services/job-wait.ts',
  'src/coordinator/services/kb-curate-assistant.ts',
  'src/coordinator/services/operation-registry.ts',
  'src/coordinator/runtime-components/contract.ts',
  'src/coordinator/runtime-components/registry.ts',
  'src/coordinator/services/recovery/actions.ts',
  'src/coordinator/services/recovery/authority-snapshot.ts',
  'src/coordinator/services/recovery/coordinator-job-source.ts',
  'src/coordinator/services/recovery/index.ts',
  'src/coordinator/services/recovery/interrupted-finalizer.ts',
  'src/coordinator/services/recovery/interrupted-performer.ts',
  'src/coordinator/services/recovery/interrupted-plan.ts',
  'src/coordinator/services/recovery/service.ts',
  'src/coordinator/services/recovery/snapshot.ts',
  'src/coordinator/services/recovery/startup-recovery.ts',
  'src/coordinator/services/provider-event-application.ts',
  'src/coordinator/services/provider-proxy-launch-route.ts',
  'src/coordinator/services/provider-proxy-operation-activation.ts',
  'src/coordinator/services/provider-proxy-set-inheritance.ts',
  'src/coordinator/services/terminal-materializer.ts',
  'src/coordinator/services/workflow-execution.ts',
  'src/coordinator/services/workflow-finalization.ts',
  'src/coordinator/services/workflow-recovery-descendants.ts',
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
  'src/jobs/wait.ts',
  // The pure carrier classifier: a jobs read contract, and the vocabulary the observer's verdicts use.
  'src/jobs/carrier-observation.ts',
  'src/kb/contract.ts',
  'src/kb/state/corpus-state.ts',
  'src/kb/search/contract.ts',
  'src/kb/projection-input-contract.ts',
  // The app-server child transport the host pool spawns through. Long a coordinator edge; it used to sit
  // inside `coordinator/live/`, so it crossed no seam to reach. Moving it to the domain that owns provider
  // process adaptation made the edge visible — it did not create one.
  'src/providers/app-server-transport.ts',
  'src/providers/contract.ts',
  'src/providers/protocol.ts',
  'src/providers/registry.ts',
  'src/provider-proxy/bootstrap-capsule.ts',
  'src/provider-proxy/control-client.ts',
  'src/provider-proxy/guardian.ts',
  'src/provider-proxy/handoff-capsule.ts',
  'src/provider-proxy/ledger.ts',
  'src/provider-proxy/orphan-deadline.ts',
  'src/provider-proxy/protocol.ts',
  'src/provider-proxy/role-spawn.ts',
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
  'src/coordinator/shutdown-recovery.ts',
  'src/coordinator/startup-recovery.ts',
  'src/coordinator/live/durable-transport.ts',
  'src/coordinator/live/kb-daemon-supervisor.ts',
]);

// `src/coordinator/runtime-components/` is deliberately not here: every one of its four files imports only
// coordinator/store/infra targets `isAlwaysPermittedTarget` already allows unconditionally, so a broad-import
// exemption for the prefix would authorize nothing it does not already have — exactly the "permission nobody
// exercises" shape the self-check below exists to catch, the same failure `carrier-observer.ts`'s deletion
// found in `OBSERVATION_AUTHORITIES.permittedImporters`.
const BROAD_IMPORT_PREFIXES = ['src/coordinator/composition/', 'src/coordinator/services/'] as const;
/**
 * Entries in `FORBIDDEN_PREFIXES` that name a path deliberately retired rather than currently real. The
 * self-check below still requires every other entry to resolve to something on disk, so a rename or deletion
 * elsewhere cannot silently narrow this ban the way `src/sessions/shell/` once did: that directory was
 * flattened to the single file `src/sessions/shell.ts` in `b78fd6a1` ("1-file lonely subdir flattened"),
 * leaving the directory-shaped ban guarding nothing until repointed below.
 */
const ASPIRATIONAL_FORBIDDEN_PREFIXES = new Set<string>([
  // Deleted for good in the rewrite (`618c95d1`, with "execution deletion" called out explicitly in
  // `7531121c`). The unconditional `target.startsWith('src/execution/')` branch below already bans it with no
  // glue exemption; this entry keeps the retired path named here too, beside every other forbidden coordinator
  // import, rather than only inside that special-cased branch.
  'src/execution/',
]);

const FORBIDDEN_PREFIXES = [
  'src/execution/',
  'src/jobs/shell/',
  'src/sessions/shell.ts',
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

/** A target every coordinator file may reach regardless of source, whether because it sits on a seam
 *  (coordinator/store/runtime/infra/security) or because it is named as domain/contract/transport public
 *  surface. Shared by the containment check below and by the exemption self-checks: an entry in
 *  `COORDINATOR_GLUE_SOURCES`/`BROAD_IMPORT_PREFIXES` only earns its broad exemption by reaching a target this
 *  function says `false` for — one it would otherwise be forbidden to reach. */
function isAlwaysPermittedTarget(target: string): boolean {
  if (
    target.startsWith('src/coordinator/') ||
    target.startsWith('src/store/') ||
    target.startsWith('src/runtime/') ||
    target.startsWith('src/infra/') ||
    target.startsWith('src/security/')
  ) {
    return true;
  }
  return DOMAIN_API_TARGETS.has(target) || CONTRACT_TARGETS.has(target) || TRANSPORT_TARGETS.has(target);
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
      if (isAlwaysPermittedTarget(target)) {
        return false;
      }
      return target.startsWith('src/');
    }).map(({ source, target }) => `${source} -> ${target}`);

    expect(violations).toEqual([]);
  });

  it('names forbidden prefixes that all resolve to something real or are explicitly retired', () => {
    // A prefix matching nothing silently narrows the ban — the module it was written for was renamed or
    // deleted, and the rule quietly stopped covering anything. `src/sessions/shell/` was exactly this before
    // being repointed to `src/sessions/shell.ts` above.
    const dangling = FORBIDDEN_PREFIXES.filter(
      (prefix) => !ASPIRATIONAL_FORBIDDEN_PREFIXES.has(prefix) && !referencesRealPath(prefix, ALL_CANONICAL_FILES),
    );
    expect(dangling).toEqual([]);
  });

  it('names KB-daemon and provider implementation targets that all resolve to something real', () => {
    const entries = [
      ...KB_RUNTIME_IMPLEMENTATION_TARGETS,
      ...KB_DAEMON_IMPLEMENTATION_TARGETS,
      ...KB_DAEMON_IMPLEMENTATION_PREFIXES,
      ...PROVIDER_IMPLEMENTATION_PREFIXES,
    ];
    const dangling = entries.filter((entry) => !referencesRealPath(entry, ALL_CANONICAL_FILES));
    expect(dangling).toEqual([]);
  });

  it('names contract and transport targets that resolve to real files actually imported somewhere in production', () => {
    // Real-but-unimported would mean the entry is exempting a target nothing reaches — a permission nobody
    // exercises is indistinguishable from one that no longer applies (see `carrier-observer.ts`'s deletion).
    const entries = [...CONTRACT_TARGETS, ...TRANSPORT_TARGETS];
    const dangling = entries.filter(
      (entry) => !referencesRealPath(entry, ALL_CANONICAL_FILES) || !ALL_EDGES.some((edge) => edge.target === entry),
    );
    expect(dangling).toEqual([]);
  });

  it('exercises every coordinator glue source and broad-import prefix exemption', () => {
    // A glue source or broad-import prefix that never actually reaches a target `isAlwaysPermittedTarget`
    // would otherwise forbid is an exemption nobody needs — indistinguishable from one for a file that was
    // renamed or tightened since the exemption was written.
    const neededByEdge = (source: string): boolean =>
      COORDINATOR_EDGES.some((edge) => edge.source === source && !isAlwaysPermittedTarget(edge.target));

    const unexercisedGlueSources = [...COORDINATOR_GLUE_SOURCES].filter(
      (source) => !referencesRealPath(source, COORDINATOR_FILE_SET) || !neededByEdge(source),
    );
    expect(unexercisedGlueSources).toEqual([]);

    const unexercisedBroadPrefixes = BROAD_IMPORT_PREFIXES.filter(
      (prefix) =>
        !referencesRealPath(prefix, COORDINATOR_FILE_SET) ||
        !COORDINATOR_EDGES.some((edge) => edge.source.startsWith(prefix) && !isAlwaysPermittedTarget(edge.target)),
    );
    expect(unexercisedBroadPrefixes).toEqual([]);
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
      return target === 'src/providers/execution-plan.ts' || startsWithAny(target, PROVIDER_IMPLEMENTATION_PREFIXES);
    }).map(({ source, target }) => `${source} -> ${target}`);

    expect(violations).toEqual([]);
    const source = readFileSync(join(REPO_ROOT, 'src/coordinator/services/kb-curate-assistant.ts'), 'utf8');
    expect(source).not.toMatch(/\baccess\s*\(/u);
  });
});
