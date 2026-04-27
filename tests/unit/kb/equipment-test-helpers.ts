import type { ConsumerHandleStatus } from '#src/coordinator/consumer-driver.js';
import type { Backed, EmbeddingService, KbRuntime, VectorRetrieval as BoundVectorRetrieval } from '#src/kb/contract.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import type { Consumer, ConsumerHandle, ConsumerRegistrationKind } from '#src/store/consumer-contract.js';
import type { Disposable } from '#src/runtime/ports.js';

export type TaggedVectorRetrieval = VectorRetrieval & { readonly backendKind?: 'needle' | 'orama' };

const vectorScopes = new WeakMap<KbRuntime, Disposable>();
const embeddingScopes = new WeakMap<KbRuntime, Disposable>();

function createScope(): Disposable {
  return {
    [Symbol.dispose]() {},
  };
}

function rebind<T>(map: WeakMap<KbRuntime, Disposable>, runtime: KbRuntime, bindingScope: Disposable): void {
  map.get(runtime)?.[Symbol.dispose]();
  map.set(runtime, bindingScope);
}

function createCorpusConsumer(
  id: string,
  registrationKind: ConsumerRegistrationKind,
  apply: Consumer['apply'] = async () => {},
): Consumer {
  return {
    id,
    authority: 'corpus',
    corpusInterest: 'content',
    registrationKind,
    apply,
  };
}

function createVectorBacked(
  retrieval: TaggedVectorRetrieval,
  consumer: Consumer,
): Backed<BoundVectorRetrieval> {
  const vector: BoundVectorRetrieval = {
    read(embedding, topK, scope) {
      return retrieval.search(embedding, topK, scope);
    },
  };
  return {
    read: () => vector,
    consumer,
  };
}

export function bindEmbedding(
  runtime: KbRuntime,
  embedding: EmbeddingService,
  options: {
    id?: string;
    registrationKind?: ConsumerRegistrationKind;
  } = {},
): void {
  const scope = createScope();
  rebind(embeddingScopes, runtime, scope);
  runtime.embedding.bind(
    {
      read: () => embedding,
      consumer: createCorpusConsumer(options.id ?? 'mock-embedder', options.registrationKind ?? 'expansion'),
    },
    scope,
    options.id ?? 'mock-embedder',
  );
}

export function createCorpusHandle(
  initial: Partial<Extract<ConsumerHandleStatus, { authority: 'corpus' }>>,
): ConsumerHandle {
  const status: Extract<ConsumerHandleStatus, { authority: 'corpus' }> = {
    authority: 'corpus',
    corpusInterest: 'content',
    snapshotId: null,
    contentSeq: 0,
    metadataSeq: 0,
    contentManifestHash: null,
    metadataManifestHash: null,
    pending: false,
    lastApplyError: null,
    ...initial,
  };

  return {
    id: 'mock-needle-handle',
    registrationKind: 'expansion',
    get lastApplyError() {
      return status.lastApplyError;
    },
    async stop() {},
    async unregister() {},
    status: () => ({ ...status }),
  };
}

export function equipVectorSlot(runtime: KbRuntime, retrieval: TaggedVectorRetrieval, handle: ConsumerHandle): void {
  const scope = createScope();
  rebind(vectorScopes, runtime, scope);
  runtime.vector.bind(
    createVectorBacked(retrieval, createCorpusConsumer(handle.id, handle.registrationKind)),
    scope,
    handle.id,
  );
}

export function seedNeedleRouteState(
  kb: {
    db: { prepare: (...args: any[]) => { run: (...params: any[]) => unknown } };
    invalidateCorpusStateSnapshot?: () => void;
  },
  snapshot: {
    snapshotId: string;
    contentSeq: number;
    metadataSeq: number;
    contentManifestHash: string;
    metadataManifestHash: string;
  },
  options: {
    cursorContentManifestHash?: string;
  } = {},
): Extract<ConsumerHandleStatus, { authority: 'corpus' }> {
  kb.db
    .prepare(
      `
        INSERT INTO kb_corpus_state (
          id,
          snapshot_id,
          content_seq,
          metadata_seq,
          content_manifest_hash,
          metadata_manifest_hash,
          last_mutation
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          content_seq = excluded.content_seq,
          metadata_seq = excluded.metadata_seq,
          content_manifest_hash = excluded.content_manifest_hash,
          metadata_manifest_hash = excluded.metadata_manifest_hash,
          last_mutation = excluded.last_mutation
      `,
    )
    .run(
      snapshot.snapshotId,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentManifestHash,
      snapshot.metadataManifestHash,
      '2026-04-01T00:00:00.000Z',
    );

  kb.invalidateCorpusStateSnapshot?.();

  return {
    authority: 'corpus',
    corpusInterest: 'content',
    snapshotId: snapshot.snapshotId,
    contentSeq: snapshot.contentSeq,
    metadataSeq: snapshot.metadataSeq,
    contentManifestHash: options.cursorContentManifestHash ?? snapshot.contentManifestHash,
    metadataManifestHash: snapshot.metadataManifestHash,
    pending: false,
    lastApplyError: null,
  };
}
