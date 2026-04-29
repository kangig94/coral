import type { Expansion } from '#src/expansion/contract.js';
import { decorateDispose } from '#src/expansion/scope.js';
import type { NeedleBackend } from './contract.js';
import { createNeedleBacked } from './backend.js';
import { createNeedleArtifactPort } from './artifact-port.js';
import { needleAddonPath } from './paths.js';
import { resolveBoundNeedleEmbedder } from './projection-identity.js';

const needle: Expansion = async (host) => {
  const embedder = host.require(host.kb.embedding);
  const resolvedEmbedder = resolveBoundNeedleEmbedder(embedder);
  const provider = await createNeedleBacked(host.kb, host.runtime, embedder, resolvedEmbedder);
  decorateDispose(host.scope, () => {
    void (provider.consumer as NeedleBackend).close().catch(() => {});
  });
  const consumer = provider.consumer as NeedleBackend;
  const handle = host.registerConsumer(
    {
      id: consumer.id,
      authority: consumer.authority,
      corpusInterest: consumer.corpusInterest,
      kind: consumer.kind,
      apply: (ctx) => consumer.apply(ctx),
    },
    host.scope,
  );
  host.registerArtifactPort(
    createNeedleArtifactPort(host.kb, {
      addonPath: needleAddonPath(host.runtime),
      expectedProjectionIdentityHash: resolvedEmbedder.projectionIdentityHash,
    }),
    { targetConsumerHandles: [handle] },
    host.scope,
  );
  host.bind(host.kb.vector, provider);
};

export default needle;
