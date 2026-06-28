import type { KbEngineRuntime } from '../kb/contract.js';
import type { KbCapabilityDescriptor, KbCapabilityName } from '../kb/capability/contract.js';
import type { EngineArtifactPort } from '../kb/corpus/artifact-port.js';
import type { EngineArtifactRegistration } from '../kb/corpus/artifact-registry.js';
import type { RetrievalRole, RetrievalRoleDescriptor, RoleHandle } from '../kb/search/contract.js';
import type { Disposable, Runtime } from '../runtime/ports.js';
import type {
  ConsumerHandle,
  CorpusConsumerRegistration,
  JournalApplyRegistration,
  StatelessProviderLifecycleRegistration,
} from '../store/consumer-contract.js';

export type Expansion = (host: ExpansionHost) => void | Promise<void>;

type HostDerivedRegistrationKind<T> = Omit<T, 'registrationKind'> & {
  readonly registrationKind?: never;
};

export type ExpansionConsumerRegistration =
  | HostDerivedRegistrationKind<JournalApplyRegistration>
  | HostDerivedRegistrationKind<CorpusConsumerRegistration>
  | HostDerivedRegistrationKind<StatelessProviderLifecycleRegistration>;

export interface ExpansionHost {
  bind<T>(name: KbCapabilityName, value: T): void;
  require<T>(name: KbCapabilityName): T;
  registerRetrievalRole(role: RetrievalRole, scope: Disposable): RoleHandle;
  registerConsumer(reg: ExpansionConsumerRegistration, scope: Disposable): ConsumerHandle;
  registerArtifactPort(
    port: EngineArtifactPort,
    options: { readonly targetConsumerHandles: readonly ConsumerHandle[] },
    scope: Disposable,
  ): EngineArtifactRegistration;
  readonly runtime: Runtime;
  readonly kb: KbEngineRuntime;
  readonly scope: Disposable;
  readonly id: string;
}

export type EngineInstallLoggerEvent = {
  readonly kind: string;
  readonly message: string;
};

export type LocalExpansionInstallState = {
  readonly targetDir: string;
  readonly addonPath?: string | null;
  readonly installLockPath: string;
  readonly version: string | null;
  readonly method: string | null;
  readonly installed: boolean;
  readonly installLocked: boolean;
  readonly durableState: boolean;
};

export interface EngineInstallerOptions {
  readonly name: string;
  readonly version: string;
  readonly runtime: Runtime;
  readonly logger?: (event: EngineInstallLoggerEvent) => void;
  readonly lockTimeoutMs?: number;
  readonly update?: boolean;
}

export interface EngineInstaller {
  install(opts: EngineInstallerOptions): Promise<unknown>;
  uninstall(opts: EngineInstallerOptions): Promise<unknown>;
  inspect(runtime: Runtime, name: string): LocalExpansionInstallState;
}

export type OnboardingStep =
  | { readonly kind: 'require-binding'; readonly binding: KbCapabilityName }
  | { readonly kind: 'env-var'; readonly name: string; readonly message?: string }
  | { readonly kind: 'confirm-download'; readonly message: string };

export interface InstallOnlyManifest {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly installer: EngineInstaller;
  readonly onboarding?: readonly OnboardingStep[];
  /** One-line usage hint surfaced to agents in the session context when this
   *  package is installed. Unlike {@link description} (catalog/install copy),
   *  this is written for an already-running agent: what the tool does and when
   *  to reach for it. Absent for internal artifacts that agents never call. */
  readonly agentSummary?: string;
}

export interface EngineManifestProvides {
  readonly retrievalRoles?: RetrievalRoleDescriptor[];
  readonly capabilities?: KbCapabilityDescriptor[];
}

export interface EngineManifest {
  readonly id: string;
  readonly version: string;
  readonly specifier: string;
  readonly tier: 'bundled' | 'installed';
  readonly description: string;
  readonly installer?: EngineInstaller;
  readonly onboarding?: readonly OnboardingStep[];
  readonly fills?: readonly KbCapabilityName[];
  readonly provides?: EngineManifestProvides;
}
