import type { Expansion } from '#src/expansion/contract.js';
import { decorateDispose } from '#src/expansion/scope.js';
import type { NeedleBackend } from './contract.js';
import { createNeedleBacked } from './backend.js';

const needle: Expansion = async (host) => {
  const embedder = host.require(host.kb.embedding);
  const provider = await createNeedleBacked(host.kb, host.runtime, embedder);
  decorateDispose(host.scope, () => {
    void (provider.consumer as NeedleBackend).close().catch(() => {});
  });
  host.registerConsumer(provider.consumer, host.scope);
  host.bind(host.kb.vector, provider);
};

export default needle;
