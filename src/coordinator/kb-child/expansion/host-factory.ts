import type { ConsumerDriver } from '../../consumer-driver/index.js';
import { createExpansionHost } from '../../../expansion/host.js';
import type { EngineManifest, ExpansionHost } from '../../../expansion/contract.js';
import type { KbRuntime } from '../../../kb/contract.js';
import type { Disposable, Runtime } from '../../../runtime/ports.js';

export interface CreateHostFactoryDeps {
  readonly runtime: Runtime;
  readonly kbRuntime: KbRuntime;
  readonly consumerDriver: ConsumerDriver;
}

export function createHostFactory(
  deps: CreateHostFactoryDeps,
): (manifest: EngineManifest, scope: Disposable) => ExpansionHost {
  return (manifest, scope) =>
    createExpansionHost({
      runtime: deps.runtime,
      kb: deps.kbRuntime,
      roleRegistry: deps.kbRuntime.roleRegistry,
      scope,
      manifest,
      consumerDriver: deps.consumerDriver,
    });
}
