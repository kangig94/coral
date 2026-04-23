import type { ConsumerDriver } from '../store/consumer-driver.js';
import type { KbCorpusPublishCallbacks } from '../kb/api.js';

export function createNotifyCorpusMutation(driver: ConsumerDriver): KbCorpusPublishCallbacks['notifyCorpusMutation'] {
  return async (publication) => {
    if (publication.changedLanes.length === 1) {
      driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
      return;
    }

    driver.notifyCorpus(publication.snapshot);
  };
}
