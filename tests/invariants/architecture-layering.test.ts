import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
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
  'src/providers/',
  'src/expansion/',
  'src/engines/',
] as const;
const RUNTIME_INFRA_FORBIDDEN = [
  ...DOMAIN_ROOTS,
  'src/transport/',
  'src/coordinator/',
  'src/cli/',
  'src/provider-proxy/',
] as const;

/**
 * The provider proxy is spawned as its own process from the backend artifact. Its whole safety argument is
 * that it carries the live provider carrier without touching daemon-owned state: it never opens the store
 * and never binds the coordinator socket, so a proxy that outlives a coordinator cannot corrupt anything
 * the successor will read. The tree is clean today, which is exactly when stating it is cheap.
 */
const PROVIDER_PROXY_ROOT = 'src/provider-proxy/';
const PROVIDERS_ROOT = 'src/providers/';
const PROVIDER_HOST_OWNER_ROOTS = ['src/coordinator/', PROVIDER_PROXY_ROOT] as const;
const PROVIDER_SOURCE_FILES = [...PRODUCTION_FILES].filter((file) => file.startsWith(PROVIDERS_ROOT)).sort();
const STORE_ROOT = 'src/store/';
const PROVIDER_PROXY_FORBIDDEN = [
  STORE_ROOT,
  'src/coordinator/',
  'src/transport/',
  'src/read-model/',
  'src/jobs/',
  'src/sessions/',
  'src/discuss/',
  'src/workflow/',
  'src/kb/',
] as const;
const SECURITY_ROOT = 'src/security/';
const SECURITY_ALLOWED = new Set([
  // Security owns work-directory admission, but the branded canonical path and its realpath implementation
  // are runtime contracts shared with persistence and recovery. These are the only non-security source edges.
  'src/runtime/canonical-work-dir.ts',
]);
const TRANSPORT_ALLOWED = new Set([
  'src/expansion/rpc-contract.ts',
  'src/jobs/contracts/abort-registry.ts',
  'src/jobs/contracts/event-stream.ts',
  'src/jobs/launch.ts',
  'src/jobs/phase.ts',
  'src/jobs/records.ts',
  'src/jobs/wait.ts',
  'src/jobs/wait-stream-event.ts',
  'src/providers/host-ref-codec.ts',
  'src/providers/host-ref-schema.ts',
  'src/providers/host-inventory-schema.ts',
  'src/sessions/command-schemas.ts',
  'src/discuss/command-schemas.ts',
  'src/discuss/read-contract.ts',
  'src/workflow/input.ts',
  'src/kb/result.ts',
  'src/kb/tool-contracts.ts',
]);
const COORDINATOR_GLUE_EXEMPT = new Set([
  'src/coordinator/index.ts',
  'src/coordinator/contracts.ts',
  'src/coordinator/lifecycle.ts',
  'src/coordinator/event-bus.ts',
  'src/coordinator/execution-service.ts',
  'src/coordinator/shutdown.ts',
  'src/coordinator/live/durable-transport.ts',
]);
const COORDINATOR_EXEMPT_PREFIXES = ['src/coordinator/composition/', 'src/coordinator/services/'] as const;
const COORDINATOR_ALLOWED = new Set([
  'src/jobs/contracts/admission.ts',
  // The app-server child transport. The coordinator's host pool has always spawned children through it; it
  // simply used to sit inside `coordinator/live/` and so crossed no boundary to reach. It is provider-domain
  // by what it does — spawning a provider's app-server child and framing its JSON-RPC — and it now lives
  // there, which makes this edge visible rather than new.
  'src/providers/app-server-transport.ts',
  'src/providers/contract.ts',
  'src/providers/host-admission.ts',
  'src/providers/host-diagnostics.ts',
  // Both independent host owners consume provider-owned serviceability policy while retaining their live state.
  'src/providers/serviceability.ts',
]);
const GENERIC_FILENAMES = ['utils.ts', 'types.ts', 'schemas.ts', 'shared.ts', 'shared-utils.ts'] as const;
const DOMAIN_ROOT_DIRS = [
  'src/provider-proxy',
  'src/jobs',
  'src/sessions',
  'src/discuss',
  'src/workflow',
  'src/kb',
  'src/providers',
  'src/expansion',
] as const;
const DOMAIN_SHELL_ROOTS = DOMAIN_ROOT_DIRS.map((root) => `${root}/shell/`);
const JOURNAL_STREAM_DOMAINS = ['jobs', 'sessions', 'discuss', 'workflow'] as const;
type JournalStreamDomain = (typeof JOURNAL_STREAM_DOMAINS)[number];

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function referencesProductionPath(entry: string): boolean {
  return entry.endsWith('/')
    ? [...PRODUCTION_FILES].some((file) => file.startsWith(entry))
    : PRODUCTION_FILES.has(entry);
}

function isCoordinatorExemptSource(source: string): boolean {
  return COORDINATOR_GLUE_EXEMPT.has(source) || startsWithAny(source, COORDINATOR_EXEMPT_PREFIXES);
}

function isCoordinatorBaseTarget(target: string): boolean {
  return (
    target.startsWith('src/coordinator/') ||
    target.startsWith('src/runtime/') ||
    target.startsWith('src/infra/') ||
    target.startsWith('src/store/')
  );
}

function requiresCoordinatorSourceExemption(source: string, target: string): boolean {
  return (
    source.startsWith('src/coordinator/') &&
    !isCoordinatorBaseTarget(target) &&
    !COORDINATOR_ALLOWED.has(target) &&
    startsWithAny(target, DOMAIN_ROOTS)
  );
}

function shellOwner(path: string): string | null {
  return DOMAIN_SHELL_ROOTS.find((root) => path.startsWith(root)) ?? null;
}

function domainOwner(path: string): string | null {
  return DOMAIN_ROOT_DIRS.find((root) => path.startsWith(`${root}/`)) ?? null;
}

function concreteImplementationOwner(path: string): string | null {
  const owner = domainOwner(path);
  if (owner === null) return null;
  return path.startsWith(`${owner}/shell/`) || path.startsWith(`${owner}/terminal/`) ? owner : null;
}

function journalStreamDomain(path: string): JournalStreamDomain | null {
  return JOURNAL_STREAM_DOMAINS.find((domain) => path.startsWith(`src/${domain}/`)) ?? null;
}

function journalDomainCycles(edges: readonly ParsedImportEdge[]): string[] {
  const dependencies = new Map<JournalStreamDomain, Set<JournalStreamDomain>>(
    JOURNAL_STREAM_DOMAINS.map((domain) => [domain, new Set()]),
  );
  for (const { source, target, runtime } of edges) {
    if (!runtime) continue;
    const sourceDomain = journalStreamDomain(source);
    const targetDomain = journalStreamDomain(target);
    if (sourceDomain !== null && targetDomain !== null && sourceDomain !== targetDomain) {
      dependencies.get(sourceDomain)?.add(targetDomain);
    }
  }

  const visiting = new Set<JournalStreamDomain>();
  const visited = new Set<JournalStreamDomain>();
  const path: JournalStreamDomain[] = [];
  const cycles: string[] = [];

  const visit = (domain: JournalStreamDomain): void => {
    if (visited.has(domain)) return;
    if (visiting.has(domain)) {
      const cycleStart = path.indexOf(domain);
      cycles.push([...path.slice(cycleStart), domain].join(' -> '));
      return;
    }

    visiting.add(domain);
    path.push(domain);
    for (const dependency of dependencies.get(domain) ?? []) visit(dependency);
    path.pop();
    visiting.delete(domain);
    visited.add(domain);
  };

  for (const domain of JOURNAL_STREAM_DOMAINS) visit(domain);
  return cycles;
}

function collectViolations(predicate: (source: string, target: string) => boolean): string[] {
  return IMPORT_EDGES.filter(({ source, target }) => predicate(source, target)).map(
    ({ source, target }) => `${source} -> ${target}`,
  );
}

function providerHostOwnerImportViolations(edges: readonly ParsedImportEdge[]): string[] {
  return edges
    .filter(
      ({ source, target }) => source.startsWith(PROVIDERS_ROOT) && startsWithAny(target, PROVIDER_HOST_OWNER_ROOTS),
    )
    .map(({ source, target }) => `${source} -> ${target}`)
    .sort();
}

describe('architecture layering invariants', () => {
  it('runtime and infra import nothing from domains, transport, coordinator, or cli', () => {
    const violations = collectViolations(
      (source, target) =>
        (source.startsWith('src/runtime/') || source.startsWith('src/infra/')) &&
        startsWithAny(target, RUNTIME_INFRA_FORBIDDEN),
    );

    expect(violations).toEqual([]);
  });

  it('security imports only security-local modules', () => {
    const violations = collectViolations((source, target) => {
      if (!source.startsWith(SECURITY_ROOT)) {
        return false;
      }

      if (target.startsWith(SECURITY_ROOT)) {
        return false;
      }

      if (SECURITY_ALLOWED.has(target)) {
        return false;
      }

      return target.startsWith('src/');
    });

    expect(violations).toEqual([]);
  });

  it('transport imports only transport-local helpers and named domain public contracts', () => {
    const violations = collectViolations((source, target) => {
      if (!source.startsWith('src/transport/')) {
        return false;
      }

      if (target.startsWith('src/transport/') || target.startsWith('src/runtime/') || target.startsWith('src/infra/')) {
        return false;
      }

      if (TRANSPORT_ALLOWED.has(target)) {
        return false;
      }

      return startsWithAny(target, DOMAIN_ROOTS) || target.startsWith('src/coordinator/');
    });

    expect(violations).toEqual([]);
  });

  it('only coordinator glue and extracted coordinator implementation leafs may bypass coordinator contract entrypoints', () => {
    const violations = collectViolations((source, target) => {
      if (!source.startsWith('src/coordinator/') || isCoordinatorExemptSource(source)) {
        return false;
      }

      if (isCoordinatorBaseTarget(target)) {
        return false;
      }

      if (COORDINATOR_ALLOWED.has(target)) {
        return false;
      }

      return startsWithAny(target, DOMAIN_ROOTS);
    });

    expect(violations).toEqual([]);
  });

  it('names only real, exercised layering exemptions', () => {
    const ruleRoots = [
      ...DOMAIN_ROOTS,
      'src/runtime/',
      'src/infra/',
      'src/transport/',
      PROVIDER_PROXY_ROOT,
      STORE_ROOT,
      SECURITY_ROOT,
      ...DOMAIN_ROOT_DIRS.map((root) => `${root}/`),
    ];
    expect(ruleRoots.filter((root) => !referencesProductionPath(root))).toEqual([]);

    const unexercisedTransportTargets = [...TRANSPORT_ALLOWED].filter(
      (target) =>
        !referencesProductionPath(target) ||
        !IMPORT_EDGES.some(
          (edge) =>
            edge.source.startsWith('src/transport/') &&
            edge.target === target &&
            (startsWithAny(edge.target, DOMAIN_ROOTS) || edge.target.startsWith('src/coordinator/')),
        ),
    );
    expect(unexercisedTransportTargets).toEqual([]);

    const unexercisedSecurityTargets = [...SECURITY_ALLOWED].filter(
      (target) =>
        !referencesProductionPath(target) ||
        !IMPORT_EDGES.some((edge) => edge.source.startsWith(SECURITY_ROOT) && edge.target === target),
    );
    expect(unexercisedSecurityTargets).toEqual([]);

    const unexercisedGlueSources = [...COORDINATOR_GLUE_EXEMPT].filter(
      (source) =>
        !referencesProductionPath(source) ||
        !IMPORT_EDGES.some(
          (edge) => edge.source === source && requiresCoordinatorSourceExemption(edge.source, edge.target),
        ),
    );
    expect(unexercisedGlueSources).toEqual([]);

    const unexercisedCoordinatorPrefixes = COORDINATOR_EXEMPT_PREFIXES.filter(
      (prefix) =>
        !referencesProductionPath(prefix) ||
        !IMPORT_EDGES.some(
          (edge) => edge.source.startsWith(prefix) && requiresCoordinatorSourceExemption(edge.source, edge.target),
        ),
    );
    expect(unexercisedCoordinatorPrefixes).toEqual([]);

    const unexercisedCoordinatorTargets = [...COORDINATOR_ALLOWED].filter(
      (target) =>
        !referencesProductionPath(target) ||
        !IMPORT_EDGES.some(
          (edge) =>
            edge.target === target &&
            edge.source.startsWith('src/coordinator/') &&
            !isCoordinatorExemptSource(edge.source) &&
            !isCoordinatorBaseTarget(edge.target) &&
            startsWithAny(edge.target, DOMAIN_ROOTS),
        ),
    );
    expect(unexercisedCoordinatorTargets).toEqual([]);
  });

  it('production files never import test helpers', () => {
    const violations = collectViolations(
      (_source, target) =>
        target.startsWith('tests/') || target.startsWith('src/testing/') || target.startsWith('tools/testing/'),
    );

    expect(violations).toEqual([]);
  });

  it('kb tool contracts stay on the transport and kb tool-handler seams', () => {
    const violations = collectViolations(
      (source, target) =>
        target === 'src/kb/tool-contracts.ts' &&
        !source.startsWith('src/transport/') &&
        source !== 'src/kb-daemon/request-service.ts' &&
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

  it('the provider proxy opens no store and reaches no coordinator surface', () => {
    const violations = IMPORT_EDGES.filter((edge) => edge.source.startsWith(PROVIDER_PROXY_ROOT))
      .filter((edge) => startsWithAny(edge.target, PROVIDER_PROXY_FORBIDDEN))
      .map((edge) => `${edge.source} -> ${edge.target}`);

    expect(violations).toEqual([]);
  });

  it('the shared providers domain reaches neither provider-host owner', () => {
    expect(providerHostOwnerImportViolations(IMPORT_EDGES)).toEqual([]);
  });

  it('scans a non-empty providers domain and names only owner roots that contain production files', () => {
    expect(PROVIDER_SOURCE_FILES.length).toBeGreaterThan(0);
    expect(PROVIDER_HOST_OWNER_ROOTS.filter((root) => !referencesProductionPath(root))).toEqual([]);
  });

  it.each([
    ['src/coordinator/index.ts', '../coordinator/index.js'],
    ['src/provider-proxy/provider-root-authority.ts', '../provider-proxy/provider-root-authority.js'],
  ] as const)('rejects a providers import of owner module %s', (target, specifier) => {
    const mutation: ParsedImportEdge = {
      source: 'src/providers/bootstrap.ts',
      target,
      specifier,
      via: 'ImportDeclaration',
      runtime: true,
      typeOnly: false,
    };

    expect(providerHostOwnerImportViolations([mutation])).toEqual([`${mutation.source} -> ${target}`]);
  });

  it('the journal store does not reach into the provider proxy', () => {
    // The Journal is durable authority below the live proxy domain; durable records validate provider
    // identities at the providers boundary instead of importing proxy protocol schemas.
    const violations = collectViolations(
      (source, target) => source.startsWith(STORE_ROOT) && target.startsWith(PROVIDER_PROXY_ROOT),
    );

    expect(violations).toEqual([]);
  });

  it('the jobs domain does not reach into the provider proxy', () => {
    // Jobs must remain meaningful without a live proxy process; proxy correlation brands stop at the wire
    // boundary and durable saga identities are validated by the store instead.
    const violations = IMPORT_EDGES.filter((edge) => edge.source.startsWith('src/jobs/'))
      .filter((edge) => edge.target.startsWith(PROVIDER_PROXY_ROOT))
      .map((edge) => `${edge.source} -> ${edge.target}`);

    expect(violations).toEqual([]);
  });

  it('domain roots do not contain generic filenames', () => {
    const banned = DOMAIN_ROOT_DIRS.flatMap((root) =>
      GENERIC_FILENAMES.map((name) => `${root}/${name}`).filter((filePath) => PRODUCTION_FILES.has(filePath)),
    );

    expect(banned).toEqual([]);
  });

  it('domain shell modules do not import sibling shell modules', () => {
    const violations = collectViolations((source, target) => {
      const sourceOwner = shellOwner(source);
      const targetOwner = shellOwner(target);
      return sourceOwner !== null && targetOwner !== null && sourceOwner !== targetOwner;
    });

    expect(violations).toEqual([]);
  });

  it('Journal-stream domain runtime imports form an acyclic graph', () => {
    expect(journalDomainCycles(IMPORT_EDGES)).toEqual([]);
  });

  it('domains do not import another domain concrete shell or terminal implementation', () => {
    const violations = collectViolations((source, target) => {
      const sourceOwner = domainOwner(source);
      const targetOwner = concreteImplementationOwner(target);
      return sourceOwner !== null && targetOwner !== null && sourceOwner !== targetOwner;
    });

    expect(violations).toEqual([]);
  });

  it('workflow reads jobs projection internals only as types — runtime access is coordinator-injected', () => {
    // Ownership matrix: workflow may read jobs only via coordinator composition.
    // jobs/read-queries.ts is not a published jobs contract surface; workflow
    // receives `loadJobDetails` through resumeAll options instead of importing it.
    const violations = IMPORT_EDGES.filter(
      ({ source, target, runtime }) =>
        source.startsWith('src/workflow/') && target === 'src/jobs/read-queries.ts' && runtime,
    ).map(({ source, target }) => `${source} -> ${target}`);

    expect(violations).toEqual([]);
  });
});
