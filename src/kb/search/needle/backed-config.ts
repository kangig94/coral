import type { KbRuntime } from '../../contract.js';
import type { NeedleBackendOptions } from './contract.js';

export interface NeedleBackedOptions extends Pick<NeedleBackendOptions, 'consumerId' | 'pluginRoot' | 'storeFactory'> {}

const NEEDLE_BACKED_OPTIONS = new WeakMap<KbRuntime, NeedleBackedOptions>();

export function configureNeedleBacked(runtime: KbRuntime, options: NeedleBackedOptions): void {
  NEEDLE_BACKED_OPTIONS.set(runtime, options);
}

export function readNeedleBackedOptions(runtime: KbRuntime): NeedleBackedOptions | undefined {
  return NEEDLE_BACKED_OPTIONS.get(runtime);
}
