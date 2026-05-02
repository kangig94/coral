import type { ConsumerDriver } from '../consumer-driver/index.js';
import { createExpansionHost, type ExpansionTier } from '../../expansion/host.js';
import type { ExpansionHost } from '../../expansion/contract.js';
import type { KbRuntime } from '../../kb/contract.js';
import type { Disposable, Runtime } from '../../runtime/ports.js';

export interface CreateHostFactoryDeps {
  readonly runtime: Runtime;
  readonly kbRuntime: KbRuntime;
  readonly consumerDriver: ConsumerDriver;
}

export function createHostFactory(
  deps: CreateHostFactoryDeps,
): (id: string, scope: Disposable, tier: ExpansionTier) => ExpansionHost {
  return (id, scope, tier) =>
    createExpansionHost({
      runtime: deps.runtime,
      kb: deps.kbRuntime,
      scope,
      id,
      tier,
      consumerDriver: deps.consumerDriver,
    });
}
