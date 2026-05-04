import type { ConsumerHandle } from '../../../store/consumer-contract.js';
import type { KbRuntime } from '../../../kb/contract.js';
import { createWakeUpCorpusConsumer } from '../../../kb/ops/wake-up.js';
import type { ConsumerDriver } from '../../consumer-driver/index.js';

export function registerWakeUpCorpusConsumer(driver: ConsumerDriver, kb: KbRuntime): ConsumerHandle {
  return driver.register(createWakeUpCorpusConsumer(kb));
}
