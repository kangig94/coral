import type { RuntimeBinding } from '../runtime/binding.js';
import type { KbRuntime } from '../kb/contracts.js';
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

export interface BundledExpansion {
  readonly id: string;
  readonly version: string;
  readonly specifier: string;
  readonly metadata: {
    readonly description: string;
    readonly repo?: string;
    readonly onboarding?: 'optional' | 'required';
    readonly slot?: string;
  };
}
