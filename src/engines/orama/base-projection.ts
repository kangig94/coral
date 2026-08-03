import { insert, remove } from '@orama/orama';

import type { FtsSearchResult, RetrievalScope } from '../../kb/search/contract.js';
import type { KbCorpusSnapshot, KbEngineRuntimeBase } from '../../kb/contract.js';
import type {
  ConsumerApplyError,
  CorpusAuthoritativeFreshness,
  CorpusAuthoritativeFreshnessTarget,
  CorpusApplyResult,
  CorpusConsumerApplyContext,
  CorpusConsumerRegistration,
} from '../../store/consumer-contract.js';
import type { KbProjectionInput, KbProjectionRecord } from '../../kb/projection-input-contract.js';
import type { GeneratedCommunityFreshness } from '../../kb/curate/community/generated-projection-store.js';
import { computeContentSurfaceHash, computeMetadataSurfaceHash } from '../../kb/corpus/snapshot.js';
import { isSnapshotFresherForInterest } from '../../kb/state/corpus-state.js';
import { noteMetadataHash, sourceMetadataHash, wikiMetadataHash } from '../../kb/metadata-hash.js';
import { createOramaDb, toOramaDocument, type KbOramaDocument } from './document-builder.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';
import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  createOramaArtifactPort,
  createOramaProjectionIdentityInput,
  type OramaEntryManifest,
  type OramaEntryManifestEntry,
  type OramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from './artifact-port.js';
import { OramaSnapshotStore, type KbCachedOramaIndex } from './snapshot.js';
import type { Runtime } from '../../runtime/ports.js';
import {
  NOOP_ANALYZER_MANAGER,
  readDeclaredAnalyzers,
  type OramaAnalyzerLeaseContext,
  type OramaAnalyzerManager,
} from './analyzer.js';
import { ORAMA_BASE_CONSUMER_ID, type OramaReconcileReason } from './constants.js';
import { insertOramaDocumentsCooperatively } from './insert-batching.js';
import { OramaSearchPort, type OramaLoadedIndex } from './search-port.js';

export interface PreparedOramaProjection {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
  documents: KbOramaDocument[];
  generatedCommunityFreshness: GeneratedCommunityFreshness;
}

type CurrentOramaDocumentMap = ReadonlyMap<string, KbOramaDocument>;

export type OramaBaseProjectionOptions = {
  readonly kiwiRuntime?: Runtime;
  readonly analyzerManager?: OramaAnalyzerManager;
  readonly requestProjectionReconcile?: (reason: OramaReconcileReason) => void;
  readonly onApplyFailure?: (error: ConsumerApplyError) => void;
};

function communityMetadataHash(rawContent: string): string {
  return computeMetadataSurfaceHash({
    rawBytes: rawContent,
  });
}

/**
 * Coordinator-facing Orama projection that serves lexical search through the
 * engine-blind FTS contract. Owns its own snapshot store (Expansion-internal
 * state) so the KB runtime stays engine-blind.
 */
export class OramaBaseProjection implements CorpusConsumerRegistration {
  readonly id = ORAMA_BASE_CONSUMER_ID;
  readonly authority = 'corpus';
  readonly corpusInterest = 'both';
  readonly kind = 'apply';
  readonly projectionSync = 'text-index';
  registrationKind: 'base' | 'expansion' = 'base';
  onApplyFailure?: (error: ConsumerApplyError) => void;
  private readonly searchPort: OramaSearchPort;
  private readonly kiwiRuntime?: Runtime;
  private readonly analyzerManager: OramaAnalyzerManager;
  private readonly requestProjectionReconcile?: (reason: OramaReconcileReason) => void;

  private readonly runtime: KbEngineRuntimeBase;
  private readonly snapshotStore: OramaSnapshotStore;
  constructor(
    runtime: KbEngineRuntimeBase,
    snapshotStore: OramaSnapshotStore,
    options: OramaBaseProjectionOptions = {},
  ) {
    this.runtime = runtime;
    this.snapshotStore = snapshotStore;
    this.kiwiRuntime = options.kiwiRuntime;
    this.analyzerManager = options.analyzerManager ?? NOOP_ANALYZER_MANAGER;
    this.requestProjectionReconcile = options.requestProjectionReconcile;
    // Apply-time failures are supplemental; primary tier reconciliation is requested by the coordinator callback.
    this.onApplyFailure =
      options.onApplyFailure ??
      (options.requestProjectionReconcile === undefined
        ? undefined
        : () => options.requestProjectionReconcile?.('terminal-analyzer-failure'));
    this.snapshotStore.setCurrentKiwiAnalyzer(() => this.analyzerManager.currentAnalyzer());
    this.searchPort = this.createSearchPort();
  }

  async apply(ctx: CorpusConsumerApplyContext): Promise<CorpusApplyResult> {
    return { advanceTo: await this.withAnalyzerLease((lease) => this.installLatestCoalescedSnapshot(ctx, lease)) };
  }

  async ensureLoaded(): Promise<OramaLoadedIndex> {
    return this.searchPort.ensureLoaded();
  }

  /**
   * Eager freshness probe. Search reads never rebuild or persist Orama
   * artifacts; a missing persisted snapshot surfaces degraded search until the
   * next corpus apply materializes it.
   */
  probeFreshness(): void {
    this.searchPort.probeFreshness();
  }

  /** Single-shot ranked lexical search; KB-tier owns the widening loop. */
  async search(query: string, topK: number, scope?: RetrievalScope): Promise<FtsSearchResult> {
    return this.searchPort.search(query, topK, scope);
  }

  /** Engine tokenizer pipeline; used for snippet anchoring. */
  tokenize(text: string): Promise<readonly string[]> {
    return this.searchPort.tokenize(text);
  }

  tokenizeBatch(texts: readonly string[]): Promise<readonly (readonly string[])[]> {
    return this.searchPort.tokenizeBatch(texts);
  }

  warnings(): readonly string[] {
    return this.searchPort.warnings();
  }

  getSearchPort(): OramaSearchPort {
    return this.searchPort;
  }

  createSearchPort(): OramaSearchPort {
    return new OramaSearchPort(this.snapshotStore, {
      runtime: this.runtime,
      kiwiRuntime: this.kiwiRuntime,
      analyzerManager: this.analyzerManager,
      projectionIdentityInput: () => this.projectionIdentityInput(),
      requestProjectionReconcile: this.requestProjectionReconcile,
    });
  }

  private projectionIdentityInput(): OramaProjectionIdentityInput {
    const declaredAnalyzers = readDeclaredAnalyzers(this.runtime);
    return createOramaProjectionIdentityInput(
      declaredAnalyzers,
      this.analyzerManager.effectiveDeclaredAnalyzers(declaredAnalyzers, this.kiwiRuntime),
    );
  }

  projectionIdentityHash(): string {
    return ORAMA_PROJECTION_IDENTITY_HASH(this.projectionIdentityInput());
  }

  readAuthoritativeFreshness(target: CorpusAuthoritativeFreshnessTarget): Promise<CorpusAuthoritativeFreshness> {
    const declaredAnalyzers = readDeclaredAnalyzers(this.runtime);
    return createOramaArtifactPort(
      this.runtime.projectionArtifacts.files,
      this.runtime.projectionArtifacts.runtimeDir,
      declaredAnalyzers,
      (declared) => this.analyzerManager.effectiveDeclaredAnalyzers(declared, this.kiwiRuntime),
    ).readAuthoritativeFreshness(target);
  }

  /** Builds a complete projection from KB-materialized corpus input. */
  async prepareFullSnapshot(input: KbProjectionInput): Promise<PreparedOramaProjection> {
    return this.prepareFullSnapshotFromDocuments(
      this.prepareCurrentDocumentMap(input),
      this.generatedCommunityFreshnessFromInput(input),
    );
  }

  private async prepareFullSnapshotFromDocuments(
    currentByEntryId: CurrentOramaDocumentMap,
    generatedCommunityFreshness: GeneratedCommunityFreshness,
    lease?: OramaAnalyzerLeaseContext,
  ): Promise<PreparedOramaProjection> {
    const { db, tokenizer } = await createOramaDb({
      currentKiwiAnalyzer: () => lease?.analyzer ?? this.analyzerManager.currentAnalyzer(),
    });

    return {
      db,
      tokenizer,
      documents: [...currentByEntryId.values()],
      generatedCommunityFreshness,
    };
  }

  async installFullSnapshot(
    snapshot: KbCorpusSnapshot,
    preparedProjection: PreparedOramaProjection,
  ): Promise<KbCorpusSnapshot> {
    return await this.withAnalyzerLease(() => this.installFullSnapshotUnlocked(snapshot, preparedProjection));
  }

  private async installFullSnapshotUnlocked(
    snapshot: KbCorpusSnapshot,
    preparedProjection: PreparedOramaProjection,
  ): Promise<KbCorpusSnapshot> {
    if (preparedProjection.documents.length > 0) {
      await insertOramaDocumentsCooperatively(preparedProjection.db, preparedProjection.documents);
    }
    const identityInput = this.projectionIdentityInput();
    const skipSnapshot = await this.staleProjectionWriteSkipSnapshot(
      snapshot,
      ORAMA_PROJECTION_IDENTITY_HASH(identityInput),
      preparedProjection.generatedCommunityFreshness,
    );
    if (skipSnapshot !== null) {
      this.searchPort.probeFreshness();
      return skipSnapshot;
    }
    const metadata = await this.snapshotStore.persistAsync(
      snapshot,
      preparedProjection.db,
      identityInput,
      preparedProjection.generatedCommunityFreshness,
    );
    this.snapshotStore.install({
      db: preparedProjection.db,
      tokenizer: preparedProjection.tokenizer,
      metadata,
    });
    this.searchPort.probeFreshness();
    return this.snapshotFromMetadata(metadata);
  }

  /**
   * Metadata-lane bursts can publish newer snapshots while Orama rebuilds.
   * Keep apply awaited until the installed artifact catches up; the driver
   * advances the consumer cursor only after this method returns.
   */
  private async installLatestCoalescedSnapshot(
    ctx: CorpusConsumerApplyContext,
    lease: OramaAnalyzerLeaseContext,
  ): Promise<KbCorpusSnapshot> {
    const { snapshot, projectionInput } = await this.resolveLatestSettledProjectionInput(ctx);
    const generatedCommunityFreshness = this.generatedCommunityFreshnessFromInput(projectionInput);
    const currentByEntryId = this.prepareCurrentDocumentMap(projectionInput);
    const loaded = await this.loadPersistedDeltaBase(lease);
    if (loaded === null) {
      return await this.installFullSnapshot(
        snapshot,
        await this.prepareFullSnapshotFromDocuments(currentByEntryId, generatedCommunityFreshness, lease),
      );
    }

    const persistedSnapshot = this.snapshotFromMetadata(loaded.metadata);
    if (
      !isSnapshotFresherForInterest(snapshot, persistedSnapshot, this.corpusInterest) &&
      this.generatedCommunityFreshnessMatches(loaded.metadata, generatedCommunityFreshness)
    ) {
      this.snapshotStore.install(loaded);
      this.searchPort.probeFreshness();
      return persistedSnapshot;
    }

    if (this.requiresFullInstallFromManifest(loaded.metadata.entryManifest, currentByEntryId)) {
      return await this.installFullSnapshot(
        snapshot,
        await this.prepareFullSnapshotFromDocuments(currentByEntryId, generatedCommunityFreshness, lease),
      );
    }

    try {
      await this.applyDeltaFromManifest(loaded.db, loaded.metadata.entryManifest, currentByEntryId);
    } catch {
      return await this.installFullSnapshot(
        snapshot,
        await this.prepareFullSnapshotFromDocuments(currentByEntryId, generatedCommunityFreshness, lease),
      );
    }

    const identityInput = this.projectionIdentityInput();
    const skipSnapshot = await this.staleProjectionWriteSkipSnapshot(
      snapshot,
      ORAMA_PROJECTION_IDENTITY_HASH(identityInput),
      generatedCommunityFreshness,
    );
    if (skipSnapshot !== null) {
      this.searchPort.probeFreshness();
      return skipSnapshot;
    }
    const metadata = await this.snapshotStore.persistAsync(
      snapshot,
      loaded.db,
      identityInput,
      generatedCommunityFreshness,
    );
    this.snapshotStore.install({
      db: loaded.db,
      tokenizer: loaded.tokenizer,
      metadata,
    });
    this.searchPort.probeFreshness();
    return this.snapshotFromMetadata(metadata);
  }

  private latestSnapshot(left: KbCorpusSnapshot, right: KbCorpusSnapshot): KbCorpusSnapshot {
    if (isSnapshotFresherForInterest(right, left, this.corpusInterest)) {
      return { ...right };
    }
    return { ...left };
  }

  private async staleProjectionWriteSkipSnapshot(
    sourceSnapshot: KbCorpusSnapshot,
    targetProjectionIdentityHash: string,
    generatedCommunityFreshness: GeneratedCommunityFreshness,
  ): Promise<KbCorpusSnapshot | null> {
    const cached = this.snapshotStore.getCache();
    if (cached?.metadata !== undefined) {
      if (
        this.shouldSkipProjectionWriteAgainstMetadata(
          cached.metadata,
          sourceSnapshot,
          targetProjectionIdentityHash,
          generatedCommunityFreshness,
        )
      ) {
        return this.snapshotFromMetadata(cached.metadata);
      }
    }

    try {
      const metadata = this.snapshotStore.loadMetadata();
      if (
        this.shouldSkipProjectionWriteAgainstMetadata(
          metadata,
          sourceSnapshot,
          targetProjectionIdentityHash,
          generatedCommunityFreshness,
        )
      ) {
        return this.snapshotFromMetadata(metadata);
      }
      return null;
    } catch {
      // A missing or unreadable persisted artifact is handled by the normal write path.
      return null;
    }
  }

  private shouldSkipProjectionWriteAgainstMetadata(
    persistedMetadata: OramaProjectionMetadata,
    sourceSnapshot: KbCorpusSnapshot,
    targetProjectionIdentityHash: string,
    generatedCommunityFreshness: GeneratedCommunityFreshness,
  ): boolean {
    if (!this.generatedCommunityFreshnessMatches(persistedMetadata, generatedCommunityFreshness)) {
      return false;
    }

    const persistedSnapshot = this.snapshotFromMetadata(persistedMetadata);
    if (this.isSnapshotStrictlyFresherForInterest(persistedSnapshot, sourceSnapshot)) {
      return true;
    }

    return (
      persistedMetadata.projectionIdentityHash === targetProjectionIdentityHash &&
      this.snapshotsMatchForInterest(persistedSnapshot, sourceSnapshot)
    );
  }

  private generatedCommunityFreshnessFromInput(input: KbProjectionInput): GeneratedCommunityFreshness {
    return {
      generatedCommunityGeneration: input.generatedCommunityGeneration,
      generatedCommunityDocsHash: input.generatedCommunityDocsHash,
    };
  }

  private generatedCommunityFreshnessMatches(
    metadata: Pick<OramaProjectionMetadata, 'generatedCommunityGeneration' | 'generatedCommunityDocsHash'>,
    expected: GeneratedCommunityFreshness,
  ): boolean {
    return (
      metadata.generatedCommunityGeneration === expected.generatedCommunityGeneration &&
      metadata.generatedCommunityDocsHash === expected.generatedCommunityDocsHash
    );
  }

  private isSnapshotStrictlyFresherForInterest(candidate: KbCorpusSnapshot, source: KbCorpusSnapshot): boolean {
    return (
      isSnapshotFresherForInterest(candidate, source, this.corpusInterest) &&
      !isSnapshotFresherForInterest(source, candidate, this.corpusInterest)
    );
  }

  // Orama has "both" corpus interest; this intentionally compares every snapshot field.
  private snapshotsMatchForInterest(left: KbCorpusSnapshot, right: KbCorpusSnapshot): boolean {
    return (
      left.snapshotId === right.snapshotId &&
      left.contentSeq === right.contentSeq &&
      left.metadataSeq === right.metadataSeq &&
      left.contentManifestHash === right.contentManifestHash &&
      left.metadataManifestHash === right.metadataManifestHash
    );
  }

  private async resolveLatestSettledProjectionInput(ctx: CorpusConsumerApplyContext): Promise<{
    snapshot: KbCorpusSnapshot;
    projectionInput: KbProjectionInput;
  }> {
    let selectedSnapshot = this.latestSnapshot(ctx.snapshot, ctx.corpusStateReader.readCurrentSnapshot());
    let projectionInput =
      selectedSnapshot.snapshotId === ctx.snapshot.snapshotId
        ? ctx.projectionInput
        : await this.runtime.corpusProjectionReader.prepareCurrentProjectionInput({
            signal: ctx.signal,
            ensureFreshness: false,
          });

    while (true) {
      const settledSnapshot = this.latestSnapshot(selectedSnapshot, ctx.corpusStateReader.readCurrentSnapshot());
      if (settledSnapshot.snapshotId === selectedSnapshot.snapshotId) {
        return { snapshot: selectedSnapshot, projectionInput };
      }

      selectedSnapshot = settledSnapshot;
      projectionInput = await this.runtime.corpusProjectionReader.prepareCurrentProjectionInput({
        signal: ctx.signal,
        ensureFreshness: false,
      });
    }
  }

  private async loadPersistedDeltaBase(
    lease: OramaAnalyzerLeaseContext,
  ): Promise<(KbCachedOramaIndex & { metadata: OramaProjectionMetadata }) | null> {
    try {
      const loaded = await this.snapshotStore.load({
        currentKiwiAnalyzer: () => lease.analyzer,
      });
      if (loaded.metadata?.projectionIdentityHash !== this.projectionIdentityHash()) {
        return null;
      }
      return loaded as KbCachedOramaIndex & { metadata: OramaProjectionMetadata };
    } catch {
      return null;
    }
  }

  private snapshotFromMetadata(metadata: OramaProjectionMetadata): KbCorpusSnapshot {
    return {
      snapshotId: metadata.snapshotId,
      contentSeq: metadata.contentSeq,
      metadataSeq: metadata.metadataSeq,
      contentManifestHash: metadata.contentManifestHash,
      metadataManifestHash: metadata.metadataManifestHash,
    };
  }

  private prepareCurrentDocumentMap(input: KbProjectionInput): CurrentOramaDocumentMap {
    const documents = this.materializeDocuments(input.records, input.communityFresh);
    const byEntryId = new Map<string, KbOramaDocument>();
    for (const document of documents) {
      byEntryId.set(document.entryId, document);
    }
    return byEntryId;
  }

  private requiresFullInstallFromManifest(
    previousManifest: OramaEntryManifest,
    currentByEntryId: CurrentOramaDocumentMap,
  ): boolean {
    const entryIds = new Set([...Object.keys(previousManifest), ...currentByEntryId.keys()]);
    for (const entryId of entryIds) {
      const previous = previousManifest[entryId];
      const current = currentByEntryId.get(entryId);
      // Orama materializes note/source/wiki/community; community is its only unstructured full-install kind.
      if (previous?.kind !== 'community' && current?.kind !== 'community') {
        continue;
      }

      const previousMetadataHash = previous?.metadataHash ?? null;
      const currentMetadataHash = current?.metadataHash ?? null;
      if (previousMetadataHash !== currentMetadataHash) {
        return true;
      }
    }
    return false;
  }

  private async applyDeltaFromManifest(
    db: KbOramaDb,
    previousManifest: OramaEntryManifest,
    currentByEntryId: CurrentOramaDocumentMap,
  ): Promise<void> {
    const replacementDocuments: KbOramaDocument[] = [];
    const insertDocuments: KbOramaDocument[] = [];

    for (const entryId of Object.keys(previousManifest).sort((left, right) => left.localeCompare(right))) {
      const previous = previousManifest[entryId];
      if (previous === undefined) {
        continue;
      }

      const current = currentByEntryId.get(entryId);
      if (current === undefined) {
        await this.removePersistedDocument(db, previous);
        continue;
      }

      if (!this.manifestEntryMatchesDocument(previous, current)) {
        await this.removePersistedDocument(db, previous);
        replacementDocuments.push(current);
      }
    }

    for (const entryId of currentByEntryId.keys()) {
      if (previousManifest[entryId] !== undefined) {
        continue;
      }
      const document = currentByEntryId.get(entryId);
      if (document !== undefined) {
        insertDocuments.push(document);
      }
    }

    for (const document of [...replacementDocuments, ...insertDocuments]) {
      await insert(db, document);
    }
  }

  private async withAnalyzerLease<T>(run: (lease: OramaAnalyzerLeaseContext) => T | Promise<T>): Promise<T> {
    const execute = () =>
      this.analyzerManager.withAnalyzerLease(this.kiwiRuntime, readDeclaredAnalyzers(this.runtime), (lease) =>
        run(lease),
      );
    try {
      return await execute();
    } catch (error: unknown) {
      if (this.analyzerManager.isTerminalLoadError?.(error) !== true) {
        throw error;
      }
      return execute();
    }
  }

  private manifestEntryMatchesDocument(previous: OramaEntryManifestEntry, current: KbOramaDocument): boolean {
    return (
      previous.documentId === current.id &&
      previous.contentHash === current.contentHash &&
      previous.metadataHash === current.metadataHash &&
      previous.kind === current.kind &&
      previous.freshness === current.freshness
    );
  }

  private async removePersistedDocument(db: KbOramaDb, previous: OramaEntryManifestEntry): Promise<void> {
    const removed = await remove(db, previous.documentId);
    if (!removed) {
      throw new Error(`projection manifest document ${previous.documentId} is missing from the Orama db`);
    }
  }

  private materializeDocuments(records: readonly KbProjectionRecord[], communityFresh: boolean): KbOramaDocument[] {
    return records.map((record) => {
      if (record.kind === 'note') {
        return toOramaDocument(
          {
            note: record.entry.slug,
            path: `notes/${record.entry.slug}.md`,
            domain: record.entry.slug.split('-')[0] ?? record.entry.slug,
            title: record.entry.title,
            body: record.body,
            tags: record.entry.tags,
            principles: record.entry.principles,
            source: record.entry.source,
            createdAt: record.entry.createdAt,
            updatedAt: record.entry.updatedAt,
            ...(record.entry.entrySeq === undefined ? {} : { entrySeq: record.entry.entrySeq }),
            ...(record.entry.related === undefined ? {} : { related: record.entry.related }),
          },
          {
            contentHash: computeContentSurfaceHash({
              title: record.entry.title,
              body: record.body,
            }),
            metadataHash: noteMetadataHash(record.entry),
          },
        );
      }

      if (record.kind === 'source') {
        return toOramaDocument(
          {
            slug: record.entry.slug,
            path: `sources/${record.entry.slug}.md`,
            title: record.entry.title,
            body: record.body,
            type: record.entry.type,
            tags: record.entry.tags,
            ...(record.entry.url === undefined ? {} : { url: record.entry.url }),
            importedAt: record.entry.importedAt,
            ...(record.entry.entrySeq === undefined ? {} : { entrySeq: record.entry.entrySeq }),
            ...(record.entry.related === undefined ? {} : { related: record.entry.related }),
          },
          {
            contentHash: computeContentSurfaceHash({
              title: record.entry.title,
              body: record.body,
            }),
            metadataHash: sourceMetadataHash(record.entry),
          },
        );
      }

      if (record.kind === 'wiki') {
        return toOramaDocument(
          {
            slug: record.entry.slug,
            path: `wiki/${record.entry.slug}.md`,
            title: record.entry.title,
            body: record.body,
            tags: record.entry.tags,
            createdAt: record.entry.createdAt,
            updatedAt: record.entry.updatedAt,
            knowledge: record.entry.knowledge,
          },
          {
            contentHash: computeContentSurfaceHash({
              title: record.entry.title,
              body: record.body,
            }),
            metadataHash: wikiMetadataHash(record.entry),
          },
        );
      }

      return toOramaDocument(
        {
          slug: record.entry.slug,
          path: `communities/${record.entry.slug}.md`,
          title: record.entry.title,
          body: record.body,
          level: record.entry.level,
          members: record.entry.members,
          ...(record.entry.parent === undefined ? {} : { parent: record.entry.parent }),
          ...(record.entry.children === undefined ? {} : { children: record.entry.children }),
          ...(record.entry.summary === undefined ? {} : { summary: record.entry.summary }),
          createdAt: record.entry.createdAt,
          updatedAt: record.entry.updatedAt,
        },
        {
          communityFresh,
          contentHash: computeContentSurfaceHash({
            title: record.entry.title,
            body: record.body,
          }),
          metadataHash: communityMetadataHash(record.rawContent),
        },
      );
    });
  }
}

/** Creates the shared Orama projection wrapper for a KB runtime. */
export function createOramaBaseProjection(
  runtime: KbEngineRuntimeBase,
  snapshotStore: OramaSnapshotStore = new OramaSnapshotStore(
    { files: runtime.projectionArtifacts.files },
    runtime.projectionArtifacts.runtimeDir,
  ),
  options: OramaBaseProjectionOptions = {},
): OramaBaseProjection {
  return new OramaBaseProjection(runtime, snapshotStore, options);
}
