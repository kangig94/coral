import type { ConsumerDriver } from './consumer-driver.js';
import type { KbCorpusPublishCallbacks, KbCorpusPublication } from '../kb/contracts.js';

export function notifyCorpusMutation(driver: ConsumerDriver, publication: KbCorpusPublication): void {
  for (const lane of publication.changedLanes) {
    driver.notify('corpus', publication.snapshot, lane);
  }
}

export function createNotifyCorpusMutation(driver: ConsumerDriver): KbCorpusPublishCallbacks['notifyCorpusMutation'] {
  return async (publication) => {
    notifyCorpusMutation(driver, publication);
  };
}
