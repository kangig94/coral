import type { Expansion } from '#src/expansion/contract.js';
import type { Disposable } from '#src/runtime/ports.js';
import type { NeedleBackend } from './contract.js';
import { createNeedleBacked } from './backend.js';

function closeNeedleOnDispose(scope: Disposable, backend: NeedleBackend): void {
  const dispose = scope[Symbol.dispose].bind(scope);
  let disposed = false;
  scope[Symbol.dispose] = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    void backend.close().catch(() => {});
    dispose();
  };
}

const needle: Expansion = async (host) => {
  const embedder = host.require(host.kb.embedding);
  const provider = await createNeedleBacked(host.kb, host.runtime, embedder);
  closeNeedleOnDispose(host.scope, provider.consumer as NeedleBackend);
  host.registerConsumer(provider.consumer, host.scope);
  host.bind(host.kb.vector, provider);
};

export default needle;
