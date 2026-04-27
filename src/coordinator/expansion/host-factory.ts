import type { ConsumerDriver } from '../consumer-driver.js';
import { createExpansionHost } from '../../expansion/host.js';
import type { ExpansionHost } from '../../expansion/contract.js';
import type { KbRuntime } from '../../kb/contracts.js';
import type { Disposable, Runtime } from '../../runtime/ports.js';

export interface CreateHostFactoryDeps {
  readonly runtime: Runtime;
  readonly kbRuntime: KbRuntime;
  readonly consumerDriver: ConsumerDriver;
}

export function createHostFactory(
  deps: CreateHostFactoryDeps,
): (id: string, scope: Disposable) => ExpansionHost {
  return (id, scope) =>
    createExpansionHost({
      runtime: deps.runtime,
      kb: deps.kbRuntime,
      scope,
      id,
      consumerDriver: deps.consumerDriver,
    });
}
