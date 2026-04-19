import type { ConsumerDriver } from './consumer-driver.js';
import type { KbCorpusPublishCallbacks } from '../kb/api.js';

export function createNotifyCorpusMutation(driver: ConsumerDriver): KbCorpusPublishCallbacks['notifyCorpusMutation'] {
  return async (publication) => {
    for (const lane of publication.changedLanes) {
      driver.notify('corpus', publication.snapshot, lane);
    }
  };
}
