import type { ConsumerApplyError, CorpusConsumerRegistration } from '../../kb/contract.js';
import type { VectorRetrieval } from '../../kb/search/contract.js';
import type { ChunkRecord, NeedleStore } from './store.js';

export const NEEDLE_CONSUMER_ID = 'needle';
export type { ChunkRecord };

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
