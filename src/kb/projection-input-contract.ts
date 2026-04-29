import type { CommunityEntry, KbIndex, NoteEntry, SourceEntry } from './entry-types.js';

export type KbProjectionRecord =
  | {
      readonly kind: 'note';
      readonly entry: NoteEntry;
      readonly body: string;
    }
  | {
      readonly kind: 'source';
      readonly entry: SourceEntry;
      readonly body: string;
    }
  | {
      readonly kind: 'community';
      readonly entry: CommunityEntry;
      readonly body: string;
      readonly rawContent: string;
    };

export interface KbProjectionInput {
  readonly index: KbIndex;
  readonly records: readonly KbProjectionRecord[];
  readonly communityFresh: boolean;
}

export interface KbGeneratedCommunityDocument {
  readonly slug: string;
  readonly content: string;
}

export interface KbProjectionInputOptions {
  readonly index?: KbIndex;
  readonly generatedCommunityDocs?: readonly KbGeneratedCommunityDocument[];
  readonly forceCommunityFresh?: boolean;
}

export interface KbCorpusProjectionReader {
  resolveCurrentIndex(): KbIndex;
  prepareCurrentProjectionInput(
    options?: Omit<KbProjectionInputOptions, 'index'> & { readonly signal?: AbortSignal },
  ): Promise<KbProjectionInput>;
}
