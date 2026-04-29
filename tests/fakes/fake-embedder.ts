import type { Expansion } from '#src/expansion/contract.js';
import type { Backed, EmbeddingService } from '#src/kb/contract.js';

type FakeEmbeddingService = EmbeddingService & {
  readonly name: string;
  readonly model: string;
  readonly dims: number;
  readonly normalization: 'l2';
  readonly specId: string;
};

function vectorFrom(text: string, index: number): Float32Array {
  return Float32Array.from([text.length, index + 1, 1]);
}

const fakeEmbedder: Expansion = (host) => {
  const service: FakeEmbeddingService = {
    name: 'mock-embeddings',
    model: 'mock-small',
    dims: 3,
    normalization: 'l2',
    specId: 'mock-small:3:l2',
    async embedDocuments(texts: string[]) {
      return texts.map((text, index) => vectorFrom(text, index));
    },
    async embedQuery(text: string) {
      return vectorFrom(text, 0);
    },
  };
  const provider: Backed<EmbeddingService> = {
    read: () => service,
    consumer: {
      id: 'test-embedder',
      kind: 'stateless',
      registrationKind: 'stateless',
    },
  };

  host.registerConsumer(provider.consumer, host.scope);
  host.bind(host.kb.embedding, provider);
};

export default fakeEmbedder;
