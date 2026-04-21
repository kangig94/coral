import type { KbRuntime } from '../../kb/contracts.js';
import { createNeedleBackend, type NeedleBackend, type NeedleBackendOptions } from '../../kb/search/needle-backend.js';

export interface ActivateNeedleOptions {
  readonly consumerId?: string;
  readonly storeFactory?: NeedleBackendOptions['storeFactory'];
}

export function activateNeedle(
  runtime: KbRuntime,
  addonPath: string,
  options: ActivateNeedleOptions = {},
): NeedleBackend {
  return createNeedleBackend(runtime, {
    addonPath,
    ...(options.consumerId === undefined ? {} : { consumerId: options.consumerId }),
    ...(options.storeFactory === undefined ? {} : { storeFactory: options.storeFactory }),
  });
}
