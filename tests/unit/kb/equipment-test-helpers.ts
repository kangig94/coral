import type { ConsumerHandleStatus } from '#src/coordinator/consumer-driver.js';
import { createEquipmentSlot, createSlotRegistry } from '#src/coordinator/equipment/slots.js';
import type { KbRuntime, KbRuntimeActivationSnapshot } from '#src/kb/contracts.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import type { ConsumerHandle } from '#src/store/consumer-contract.js';

function runtimeActivationFromHandle(
  retrieval: VectorRetrieval,
  handle: ConsumerHandle,
): KbRuntimeActivationSnapshot {
  const status = handle.status();
  if (status.authority !== 'corpus') {
    return { retrieval, snapshotId: null, contentSeq: 0, contentManifestHash: null };
  }
  return {
    retrieval,
    snapshotId: status.snapshotId,
    contentSeq: status.contentSeq,
    contentManifestHash: status.contentManifestHash,
  };
}

export type TaggedVectorRetrieval = VectorRetrieval & { readonly backendKind?: 'needle' | 'orama' };

export const equipmentViewResolvers = new WeakMap<KbRuntime, () => KbRuntimeActivationSnapshot | null>();

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
    registrationKind: 'equipment',
    get lastApplyError() {
      return status.lastApplyError;
    },
    async stop() {},
    async unregister() {},
    status: () => ({ ...status }),
  };
}

export function equipVectorSlot(runtime: KbRuntime, retrieval: TaggedVectorRetrieval, handle: ConsumerHandle): void {
  const registry = createSlotRegistry();
  const slot = createEquipmentSlot<VectorRetrieval>({
    id: 'kb.vector',
    defaultOwner: () => runtime.getBaseRetrievalSurface(),
  });
  registry.declare(slot);
  slot.equip(retrieval, handle);
  equipmentViewResolvers.set(runtime, () => {
    const slotView = registry.list().find((entry) => entry.id === slot.id);
    return slotView?.handle ? runtimeActivationFromHandle(slot.currentOwner(), slotView.handle) : null;
  });
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
