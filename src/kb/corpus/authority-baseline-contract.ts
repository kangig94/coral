export type CorpusAuthorityBaselineRecord = {
  readonly entryId: string;
  readonly contentHash: string;
  readonly metadataHash: string;
};

export type CorpusAuthorityBaselineMap = Map<string, CorpusAuthorityBaselineRecord>;

export interface CorpusAuthorityBaselineStore {
  ensure(scan: unknown): { readonly baseline: CorpusAuthorityBaselineMap; readonly rebuilt: boolean };
  rebuild(scan: unknown): CorpusAuthorityBaselineMap;
  read(): CorpusAuthorityBaselineMap;
  replace(records: readonly CorpusAuthorityBaselineRecord[]): void;
}
