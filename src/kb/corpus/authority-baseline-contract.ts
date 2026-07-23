export type CorpusAuthorityBaselineRecord = {
  readonly entryId: string;
  readonly contentHash: string;
  readonly metadataHash: string;
};

export type CorpusAuthorityBaselineMap = Map<string, CorpusAuthorityBaselineRecord>;

export type CorpusAuthorityBaselineGeneration = {
  readonly generationId: string;
};

export type CorpusAuthorityBaselineDelta = {
  readonly upserts: readonly CorpusAuthorityBaselineRecord[];
  readonly deletes: readonly string[];
};

export interface CorpusAuthorityBaselineStore {
  ensure(scan: unknown): { readonly baseline: CorpusAuthorityBaselineMap; readonly rebuilt: boolean };
  rebuild(scan: unknown): CorpusAuthorityBaselineMap;
  read(): CorpusAuthorityBaselineMap;
  replace(records: readonly CorpusAuthorityBaselineRecord[]): void;
  readActiveGenerationId(): string;
  stageReplacement(
    records: readonly CorpusAuthorityBaselineRecord[],
    generationId?: string,
  ): CorpusAuthorityBaselineGeneration;
  adoptStagedGeneration(generationId: string): void;
  discardStagedGeneration(generationId: string): void;
  applyDelta(delta: CorpusAuthorityBaselineDelta): void;
  cleanupInactiveGenerations(): void;
}
