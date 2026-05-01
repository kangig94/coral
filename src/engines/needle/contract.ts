import type { ConsumerApplyError, CorpusConsumerRegistration } from '../../store/consumer-contract.js';
import type { VectorRetrieval } from '../../kb/search/contract.js';
import type { NeedleStore } from './store.js';

export const NEEDLE_CONSUMER_ID = 'needle';

export interface NeedleBackendOptions {
  consumerId?: string;
  addonPath: string;
  pluginRoot?: string;
  storeFactory?: (runtimeDir: string) => NeedleStore | null;
}

export type NeedleBackend = VectorRetrieval &
  CorpusConsumerRegistration & {
    onApplyFailure?: (error: ConsumerApplyError) => void;
    close(): Promise<void>;
  };
