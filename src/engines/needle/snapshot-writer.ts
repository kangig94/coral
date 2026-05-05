import { nowIsoString } from '../../infra/time.js';
import { chunkEntry, type ChunkSeed } from '../../kb/chunking.js';
import type { KbEngineRuntime, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import type { KbProjectionInput } from '../../kb/projection-input-contract.js';
import type { CorpusConsumerApplyContext } from '../../store/consumer-contract.js';
import { type ChunkRecord, type NeedleStore } from './store.js';
import type { ResolvedNeedleEmbedder } from './projection-identity.js';
import type { NeedleSnapshotManifest } from './artifact-port.js';
import { needleSnapshotManifestPath } from './paths.js';

const NEEDLE_EMBEDDING_BATCH_SIZE = 128;

type NeedleSnapshotWriterOptions = {
  readonly runtime: {
    readonly time: Pick<KbEngineRuntime['time'], 'now'>;
    readonly projectionArtifacts: {
      readonly files: Pick<KbProjectionArtifactFilePort, 'writeTextAtomic'>;
    };
  };
  readonly store: NeedleStore;
  readonly snapshotDir: string;
  readonly snapshot: CorpusConsumerApplyContext['snapshot'];
  readonly input: KbProjectionInput;
  readonly embedder: ResolvedNeedleEmbedder;
};

type NeedleSnapshotWriteStats = {
  readonly entryCount: number;
  readonly chunkCount: number;
};

export class NeedleSnapshotWriter {
  private entryCount = 0;
  private chunkCount = 0;

  constructor(private readonly options: NeedleSnapshotWriterOptions) {}

  async write(): Promise<NeedleSnapshotWriteStats> {
    await this.ensureActiveSpec();

    let pendingChunks: ChunkSeed[] = [];
    for (const record of this.options.input.records) {
      if (record.kind !== 'note' && record.kind !== 'source') {
        continue;
      }

      this.entryCount += 1;
      pendingChunks.push(...chunkEntry(record.entry, record.body));
      if (pendingChunks.length >= NEEDLE_EMBEDDING_BATCH_SIZE) {
        await this.writeChunkBatch(pendingChunks);
        pendingChunks = [];
      }
    }

    await this.writeChunkBatch(pendingChunks);
    await this.options.store.buildIndex();
    this.writeManifest();

    return {
      entryCount: this.entryCount,
      chunkCount: this.chunkCount,
    };
  }

  private async ensureActiveSpec(): Promise<void> {
    const desiredSpec = this.options.embedder.spec;
    const currentSpec = await this.options.store.getActiveSpec();
    if (currentSpec?.specId === desiredSpec.specId) {
      return;
    }

    await this.options.store.setActiveSpec({
      specId: desiredSpec.specId,
      provider: desiredSpec.provider,
      model: desiredSpec.model,
      dims: desiredSpec.dims,
      normalization: desiredSpec.normalization,
      createdAt: currentSpec?.createdAt ?? nowIsoString(this.options.runtime.time),
    });
  }

  private async writeChunkBatch(chunks: readonly ChunkSeed[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const vectors = await this.options.embedder.service.embedDocuments(chunks.map((chunk) => chunk.text));
    const upserts: ChunkRecord[] = [];
    for (let indexPosition = 0; indexPosition < chunks.length; indexPosition += 1) {
      const chunk = chunks[indexPosition];
      if (chunk === undefined) {
        continue;
      }
      const vector = vectors[indexPosition];
      if (vector === undefined) {
        throw new Error(`Embedding provider returned too few vectors for ${chunk.entryId}.`);
      }

      upserts.push({
        ...chunk,
        specId: this.options.embedder.spec.specId,
        vector,
      });
    }

    await this.options.store.upsertChunks(upserts);
    this.chunkCount += chunks.length;
  }

  private writeManifest(): void {
    const { embedder, snapshot } = this.options;
    writeSnapshotManifest(this.options.runtime, this.options.snapshotDir, {
      snapshot: {
        snapshotId: snapshot.snapshotId,
        contentSeq: snapshot.contentSeq,
        metadataSeq: snapshot.metadataSeq,
        contentManifestHash: snapshot.contentManifestHash,
        metadataManifestHash: snapshot.metadataManifestHash,
        projectionIdentityHash: embedder.projectionIdentityHash,
      },
      specId: embedder.spec.specId,
      entryCount: this.entryCount,
      chunkCount: this.chunkCount,
    });
  }
}

function writeSnapshotManifest(
  runtime: Pick<NeedleSnapshotWriterOptions['runtime'], 'projectionArtifacts'>,
  snapshotDir: string,
  manifest: NeedleSnapshotManifest,
): void {
  runtime.projectionArtifacts.files.writeTextAtomic(
    needleSnapshotManifestPath(snapshotDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
