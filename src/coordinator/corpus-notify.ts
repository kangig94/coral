import type { ConsumerDriver } from './consumer-driver.js';
import type { KbCorpusPublishCallbacks } from '../kb/contracts.js';

export function createNotifyCorpusMutation(driver: ConsumerDriver): KbCorpusPublishCallbacks['notifyCorpusMutation'] {
  return async (publication) => {
    if (publication.changedLanes.length === 1) {
      driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
      return;
    }

    driver.notifyCorpus(publication.snapshot);
  };
}
