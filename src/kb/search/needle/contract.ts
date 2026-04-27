import type { ConsumerApplyError, CorpusConsumerRegistration, KbRuntime } from '../../contract.js';
import type { VectorRetrieval } from '../contract.js';
import type { NeedleStore } from './store.js';

export const NEEDLE_CONSUMER_ID = 'needle';

export interface NeedleBackendOptions {
  consumerId?: string;
  addonPath: string;
  pluginRoot?: string;
  storeFactory?: (runtimeDir: string) => NeedleStore | null;
}

export type NeedleBackend = VectorRetrieval & CorpusConsumerRegistration & {
  onApplyFailure?: (error: ConsumerApplyError) => void;
  close(): Promise<void>;
};

export type NeedleBackendModule = {
  createNeedleBackend(runtime: KbRuntime, options: NeedleBackendOptions): NeedleBackend;
  closeNeedleBackend(runtime: KbRuntime): Promise<void>;
};
