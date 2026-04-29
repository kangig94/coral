import type { KbEngineRuntime, KbRuntime } from '../kb/contract.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { RuntimeBinding } from '../runtime/binding.js';
import type { Disposable, Runtime } from '../runtime/ports.js';
import type {
  ConsumerHandle,
  ConsumerRegistration,
  ConsumerRegistrationKind,
  CorpusStateReadPort,
  JournalConsumerReadPort,
} from '../store/consumer-contract.js';
import type { ExpansionConsumerRegistration, ExpansionHost } from './contract.js';
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

export type ExpansionTier = 'bundled' | 'installed';

export interface ExpansionHostDeps {
  readonly runtime: Runtime;
  readonly kb: KbRuntime;
  readonly scope: Disposable;
  readonly id: string;
  readonly tier: ExpansionTier;
  readonly consumerDriver: ConsumerDriverPort;
}

const REGISTERED_CONSUMER_HANDLES = Symbol('expansion-registered-consumer-handles');
const REGISTERED_ARTIFACT_PORTS = Symbol('expansion-registered-artifact-ports');

type ExpansionScope = Disposable & {
  [REGISTERED_CONSUMER_HANDLES]?: ConsumerHandle[];
  [REGISTERED_ARTIFACT_PORTS]?: EngineArtifactRegistration[];
};

function bindingNameOf<T>(binding: RuntimeBinding<T>, error: unknown): string {
  const fromError = error instanceof CoralSetupError ? error.context?.binding : undefined;
  return typeof fromError === 'string' && fromError.length > 0 ? fromError : binding.name;
}

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
    projectionArtifacts: kb.projectionArtifacts,
    corpusProjectionReader: kb.corpusProjectionReader,
    journalReader: consumerDriver.getJournalReader(),
    corpusStateReader: consumerDriver.getCorpusStateReader(),
    vector: kb.vector,
    embedding: kb.embedding,
    fts: kb.fts,
  };
}

export function registeredConsumerHandles(scope: Disposable): readonly ConsumerHandle[] {
  return (scope as ExpansionScope)[REGISTERED_CONSUMER_HANDLES] ?? [];
}

export function registeredArtifactPorts(scope: Disposable): readonly EngineArtifactRegistration[] {
  return (scope as ExpansionScope)[REGISTERED_ARTIFACT_PORTS] ?? [];
}

export function createExpansionHost(deps: ExpansionHostDeps): ExpansionHost {
  const engineKb = engineFacingKbRuntime(deps.kb, deps.consumerDriver);
  const host: ExpansionHost = {
    runtime: deps.runtime,
    kb: engineKb,
    scope: deps.scope,
    id: deps.id,
    bind(binding, value) {
      binding.bind(value, host.scope, host.id);
    },
    require(binding) {
      try {
        return binding.read();
      } catch (error) {
        if (!(error instanceof CoralSetupError) || error.code !== 'binding_empty') {
          throw error;
        }
        const bindingName = bindingNameOf(binding, error);
        throw documentedCoralSetupError('binding_required', { binding: bindingName, requiredBy: host.id });
      }
    },
    registerConsumer(reg, scope) {
      const registrationKind = deriveRegistrationKind(deps.tier, reg);
      const tierAware: ConsumerRegistration = { ...reg, registrationKind } as ConsumerRegistration;
      const handle = deps.consumerDriver.register(tierAware);
      const expandedScope = scope as ExpansionScope;
      const handles = expandedScope[REGISTERED_CONSUMER_HANDLES] ?? [];
      handles.push(handle);
      expandedScope[REGISTERED_CONSUMER_HANDLES] = handles;
      decorateDispose(scope, () => {
        void handle.stop().catch(() => {}).then(() => handle.unregister()).catch(() => {});
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
