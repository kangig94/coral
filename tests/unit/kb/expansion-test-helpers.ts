import { loadExpansions } from '#src/expansion/loader.js';
import type { Backed, EmbeddingService, KbRuntime, VectorRetrieval as BoundVectorRetrieval } from '#src/kb/contract.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import type { ConsumerHandle, ConsumerHandleStatus, ConsumerRegistrationKind } from '#src/store/consumer-contract.js';
import type { Disposable } from '#src/runtime/ports.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

export type TaggedVectorRetrieval = VectorRetrieval & { readonly backendKind?: 'needle' | 'orama' };

const vectorScopes = new WeakMap<KbRuntime, Disposable>();
const embedderScopes = new WeakMap<KbRuntime, readonly Disposable[]>();
const embedderKeys = new WeakMap<KbRuntime, string>();
let nextEmbedderId = 0;

function createScope(): Disposable {
  return {
    [Symbol.dispose]() {},
  };
}

function registry(): Map<string, EmbeddingService> {
  const globalState = globalThis as typeof globalThis & {
    __coralTestEmbedderRegistry__?: Map<string, EmbeddingService>;
  };
  if (!globalState.__coralTestEmbedderRegistry__) {
    globalState.__coralTestEmbedderRegistry__ = new Map<string, EmbeddingService>();
  }
  return globalState.__coralTestEmbedderRegistry__;
}

function disposeScopes(scopes: readonly Disposable[]): void {
  for (const scope of [...scopes].reverse()) {
    scope[Symbol.dispose]();
  }
}

function rebind<T>(map: WeakMap<KbRuntime, T>, runtime: KbRuntime, next: T, disposePrevious: (value: T) => void): void {
  const previous = map.get(runtime);
  if (previous !== undefined) {
    disposePrevious(previous);
  }
  map.set(runtime, next);
}

function createCorpusConsumer(
  id: string,
  registrationKind: ConsumerRegistrationKind,
  apply: (() => Promise<void>) | (() => void) = async () => {},
) {
  return {
    id,
    authority: 'corpus' as const,
    corpusInterest: 'content' as const,
    registrationKind,
    apply,
  };
}

function createVectorBacked(
  retrieval: TaggedVectorRetrieval,
  consumer: ReturnType<typeof createCorpusConsumer>,
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

export async function bindEmbedding(
  runtime: KbRuntime,
  embedding: EmbeddingService,
  options: {
    id?: string;
    registrationKind?: ConsumerRegistrationKind;
  } = {},
): Promise<void> {
  const previousScopes = embedderScopes.get(runtime);
  if (previousScopes) {
    disposeScopes(previousScopes);
  }
  const previousKey = embedderKeys.get(runtime);
  if (previousKey) {
    registry().delete(previousKey);
  }

  const key = `embedder-${nextEmbedderId += 1}`;
  const id = options.id ?? 'test-embedder';
  registry().set(key, embedding);
  embedderKeys.set(runtime, key);

  const source = `
    export default (host) => {
      const service = globalThis.__coralTestEmbedderRegistry__?.get(${JSON.stringify(key)});
      if (!service) {
        throw new Error('Missing test embedder service: ' + ${JSON.stringify(key)});
      }
      const provider = {
        read: () => service,
        consumer: {
          id: ${JSON.stringify(id)},
          authority: 'journal',
          registrationKind: ${JSON.stringify(options.registrationKind ?? 'stateless')},
        },
      };
      host.registerConsumer(provider.consumer, host.scope);
      host.bind(host.kb.embedding, provider);
    };
  `;
  const specifier = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const { makeHost } = createTestRuntime({ kb: runtime });
  const scopes = await loadExpansions(makeHost, [{
    id,
    version: '0.0.0',
    specifier,
    metadata: {
      description: 'test embedder',
      slot: 'kb.embedding',
    },
  }]);
  rebind(embedderScopes, runtime, scopes, disposeScopes);
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

export function bindVectorBacked(runtime: KbRuntime, retrieval: TaggedVectorRetrieval, handle: ConsumerHandle): void {
  const scope = createScope();
  rebind(vectorScopes, runtime, scope, (previous) => previous[Symbol.dispose]());
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
