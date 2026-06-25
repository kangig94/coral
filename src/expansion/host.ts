import type { KbEngineRuntime, KbRuntime } from '../kb/contract.js';
import type { RetrievalRole, RoleHandle, RoleRegistry } from '../kb/search/contract.js';
import { normalizeRetrievalRoleDescriptor } from '../kb/search/role-registry.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import { throwIfAborted } from '../runtime/abort.js';
import type { Disposable, Runtime } from '../runtime/ports.js';
import type {
  ConsumerHandle,
  ConsumerRegistration,
  ConsumerRegistrationKind,
  CorpusStateReadPort,
  JournalConsumerReadPort,
} from '../store/consumer-contract.js';
import type { EngineManifest, ExpansionConsumerRegistration, ExpansionHost } from './contract.js';
import { decorateDispose } from './scope.js';
import type { EngineArtifactRegistration } from '../kb/corpus/artifact-registry.js';

// Narrow port over the coordinator's ConsumerDriver. The host receives only
// the registration entrypoint, not the full coordinator class — keeps
// `src/expansion/` from importing `coordinator/` (a lower layer must not
// reach into a higher one).
export interface ConsumerDriverPort {
  register(reg: ConsumerRegistration): ConsumerHandle;
  getJournalReader(): JournalConsumerReadPort;
  getCorpusStateReader(): CorpusStateReadPort;
}

type ExpansionTier = EngineManifest['tier'];

export interface ExpansionHostDeps {
  readonly runtime: Runtime;
  readonly kb: KbRuntime;
  readonly roleRegistry: RoleRegistry;
  readonly scope: Disposable;
  readonly manifest: EngineManifest;
  readonly consumerDriver: ConsumerDriverPort;
}

const REGISTERED_CONSUMER_HANDLES = Symbol('expansion-registered-consumer-handles');
const REGISTERED_ARTIFACT_PORTS = Symbol('expansion-registered-artifact-ports');

type ExpansionScope = Disposable & {
  [REGISTERED_CONSUMER_HANDLES]?: ConsumerHandle[];
  [REGISTERED_ARTIFACT_PORTS]?: EngineArtifactRegistration[];
};

/**
 * Derives `registrationKind` from `(tier, reg.kind)`. Engine code declares
 * `kind` (`'cursor' | 'apply' | 'stateless'`) on the registration; the host
 * decides the lifecycle/storage tier:
 *  - stateless registrations               → 'stateless' (no cursor, no apply)
 *  - bundled tier (cursor or apply)        → 'base'      (auto-equips at boot, owns the cursor)
 *  - installed tier (cursor or apply)      → 'expansion' (projection consumer)
 */
function deriveRegistrationKind(tier: ExpansionTier, reg: ExpansionConsumerRegistration): ConsumerRegistrationKind {
  if (reg.kind === 'stateless') {
    return 'stateless';
  }
  return tier === 'bundled' ? 'base' : 'expansion';
}

function engineFacingKbRuntime(kb: KbRuntime, consumerDriver: ConsumerDriverPort): KbEngineRuntime {
  return {
    runtimeDir: kb.runtimeDir,
    time: kb.time,
    ids: kb.ids,
    declaredAnalyzers: kb.declaredAnalyzers,
    projectionArtifacts: kb.projectionArtifacts,
    corpusProjectionReader: kb.corpusProjectionReader,
    journalReader: consumerDriver.getJournalReader(),
    corpusStateReader: consumerDriver.getCorpusStateReader(),
    capabilities: kb.capabilityRegistry.catalogView(),
    roleCatalog: kb.roleRegistry.catalogView(),
  };
}

function descriptorsEqual(left: RetrievalRole['descriptor'], right: RetrievalRole['descriptor']): boolean {
  // Both descriptors are pre-normalized via normalizeRetrievalRoleDescriptor,
  // which constructs fields in a stable order (id, label, tags, phase,
  // supportsScopes, then optional requires, then provides). JSON.stringify
  // is stable for that input shape. If the normalizer changes field order,
  // update this comment AND verify descriptor-drift tests still catch
  // per-field mismatches.
  return JSON.stringify(left) === JSON.stringify(right);
}

function roleDescriptorMismatch(context: Record<string, unknown>): CoralSetupError {
  return documentedCoralSetupError('role_descriptor_mismatch', context);
}

function normalizeRoleDescriptorOrThrow(
  descriptor: RetrievalRole['descriptor'],
  context: Record<string, unknown>,
): RetrievalRole['descriptor'] {
  try {
    return normalizeRetrievalRoleDescriptor(descriptor);
  } catch {
    throw roleDescriptorMismatch(context);
  }
}

export function registeredConsumerHandles(scope: Disposable): readonly ConsumerHandle[] {
  return (scope as ExpansionScope)[REGISTERED_CONSUMER_HANDLES] ?? [];
}

export function registeredArtifactPorts(scope: Disposable): readonly EngineArtifactRegistration[] {
  return (scope as ExpansionScope)[REGISTERED_ARTIFACT_PORTS] ?? [];
}

export function createExpansionHost(deps: ExpansionHostDeps): ExpansionHost {
  const engineKb = engineFacingKbRuntime(deps.kb, deps.consumerDriver);
  const runtimeCapabilities = deps.kb.capabilityRegistry.runtimeView();
  const declaredFills = deps.manifest.fills ?? [];
  const declaredRequires: string[] = [];
  for (const step of deps.manifest.onboarding ?? []) {
    if (step.kind === 'require-binding') {
      declaredRequires.push(step.binding);
    }
  }
  for (const descriptor of deps.manifest.provides?.retrievalRoles ?? []) {
    for (const requirement of descriptor.requires ?? []) {
      declaredRequires.push(requirement);
    }
  }
  const fillSet = new Set(declaredFills);
  const requireSet = new Set(declaredRequires);
  const host: ExpansionHost = {
    runtime: deps.runtime,
    kb: engineKb,
    scope: deps.scope,
    id: deps.manifest.id,
    bind(name, value) {
      if (!fillSet.has(name)) {
        throw documentedCoralSetupError({
          code: 'capability_fill_undeclared',
          expansion: host.id,
          name,
          declaredFills,
        });
      }
      runtimeCapabilities.bind(name, value, host.scope, host.id);
    },
    require(name) {
      if (!requireSet.has(name)) {
        throw documentedCoralSetupError({
          code: 'capability_require_undeclared',
          expansion: host.id,
          name,
          declaredRequires,
        });
      }
      try {
        return runtimeCapabilities.read(name);
      } catch (error) {
        if (!(error instanceof CoralSetupError) || error.code !== 'binding_empty') {
          throw error;
        }
        const bindingName = typeof error.context?.binding === 'string' ? error.context.binding : name;
        throw documentedCoralSetupError('binding_required', { binding: bindingName, requiredBy: host.id });
      }
    },
    registerRetrievalRole(role, scope): RoleHandle {
      const manifestDescriptor = deps.manifest.provides?.retrievalRoles?.find(
        (descriptor) => descriptor.id === role.id,
      );
      if (manifestDescriptor === undefined) {
        throw roleDescriptorMismatch({
          expansion: host.id,
          roleId: role.id,
          reason: 'role.id not in manifest.provides.retrievalRoles',
        });
      }

      const canonicalLiveDescriptor = normalizeRoleDescriptorOrThrow(role.descriptor, {
        expansion: host.id,
        roleId: role.id,
        reason: 'live role descriptor failed validation',
      });
      const canonicalManifestDescriptor = normalizeRoleDescriptorOrThrow(manifestDescriptor, {
        expansion: host.id,
        roleId: role.id,
        reason: 'manifest role descriptor failed validation',
      });
      if (!descriptorsEqual(canonicalLiveDescriptor, canonicalManifestDescriptor)) {
        throw roleDescriptorMismatch({
          expansion: host.id,
          roleId: role.id,
          reason: 'live role descriptor differs from manifest declaration',
          liveDescriptor: canonicalLiveDescriptor,
          manifestDescriptor: canonicalManifestDescriptor,
        });
      }

      const wrappedRole: RetrievalRole = {
        id: role.id,
        descriptor: canonicalManifestDescriptor,
        search: role.search.bind(role),
      };
      return deps.roleRegistry.registerScoped(wrappedRole, scope);
    },
    registerConsumer(reg, scope) {
      const registrationKind = deriveRegistrationKind(deps.manifest.tier, reg);
      const tierAware: ConsumerRegistration = { ...reg, registrationKind } as ConsumerRegistration;
      const handle = deps.consumerDriver.register(tierAware);
      const expandedScope = scope as ExpansionScope;
      const handles = expandedScope[REGISTERED_CONSUMER_HANDLES] ?? [];
      handles.push(handle);
      expandedScope[REGISTERED_CONSUMER_HANDLES] = handles;
      decorateDispose(scope, () => {
        void handle
          .stop()
          .catch(() => {})
          .then(() => handle.unregister())
          .catch(() => {});
      });
      return handle;
    },
    registerArtifactPort(port, options, scope) {
      const registration = deps.kb.engineArtifactRegistry.register(port, options, scope);
      const expandedScope = scope as ExpansionScope;
      const registrations = expandedScope[REGISTERED_ARTIFACT_PORTS] ?? [];
      registrations.push(registration);
      expandedScope[REGISTERED_ARTIFACT_PORTS] = registrations;
      decorateDispose(scope, () => {
        registration.unregister();
      });
      return registration;
    },
  };

  return host;
}

/**
 * Tear down an expansion scope in the order required by the projection
 * boundary contract: artifact-port unregistrations run BEFORE consumer-handle
 * stop/unregister so that stale descriptors cannot target consumers whose
 * handles have already been disposed (§16 #19 lifecycle ordering).
 *
 * `registerConsumer` and `registerArtifactPort` also decorate the raw scope
 * so direct scope disposal remains self-contained. This ordered lifecycle path
 * intentionally repeats those idempotent unregister calls before running the
 * decorated callbacks (LIFO via `decorateDispose`).
 */
export async function disposeExpansionScope(scope: Disposable, options: { signal?: AbortSignal } = {}): Promise<void> {
  const signal = options.signal;
  if (signal !== undefined) {
    throwIfAborted(signal, 'expansion_scope_dispose');
  }
  for (const registration of registeredArtifactPorts(scope)) {
    registration.unregister();
  }
  for (const handle of registeredConsumerHandles(scope)) {
    if (signal !== undefined) {
      throwIfAborted(signal, 'expansion_scope_consumer_stop');
    }
    await handle.stop().catch(() => {});
    if (signal !== undefined) {
      throwIfAborted(signal, 'expansion_scope_consumer_unregister');
    }
    await handle.unregister().catch(() => {});
  }
  if (signal !== undefined) {
    throwIfAborted(signal, 'expansion_scope_symbol_dispose');
  }
  scope[Symbol.dispose]();
}
