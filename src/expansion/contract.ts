import type { RuntimeBinding } from '../runtime/binding.js';
import type { KbRuntime } from '../kb/contract.js';
import type { Disposable, Runtime } from '../runtime/ports.js';
import type { ConsumerHandle, ConsumerRegistration } from '../store/consumer-contract.js';

export type Expansion = (host: ExpansionHost) => void | Promise<void>;

export interface ExpansionHost {
  bind<T>(binding: RuntimeBinding<T>, value: T): void;
  require<T>(binding: RuntimeBinding<T>): T;
  registerConsumer(reg: ConsumerRegistration, scope: Disposable): ConsumerHandle;
  readonly runtime: Runtime;
  readonly kb: KbRuntime;
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
  | { readonly kind: 'require-binding'; readonly binding: string }
  | { readonly kind: 'env-var'; readonly name: string; readonly message?: string }
  | { readonly kind: 'confirm-download'; readonly message: string };

export interface EngineManifest {
  readonly id: string;
  readonly version: string;
  readonly specifier: string;
  readonly tier: 'bundled' | 'installed';
  readonly description: string;
  readonly installer?: EngineInstaller;
  readonly onboarding?: readonly OnboardingStep[];
  readonly fills?: readonly string[];
}
