import { computeMetadataSurfaceHash, type CanonicalFrontmatterRecord } from './corpus/snapshot.js';
import type { NoteEntry, SourceEntry, WikiEntry } from './entry-types.js';

type NoteMetadataHashInput = Pick<
  NoteEntry,
  'tags' | 'principles' | 'source' | 'createdAt' | 'updatedAt' | 'entrySeq' | 'related'
>;
type SourceMetadataHashInput = Pick<SourceEntry, 'type' | 'tags' | 'url' | 'importedAt' | 'entrySeq' | 'related'>;
type WikiMetadataHashInput = Pick<
  WikiEntry,
  'tags' | 'references_principles' | 'createdAt' | 'updatedAt' | 'entrySeq' | 'related'
>;

export function noteMetadataHash(entry: NoteMetadataHashInput): string {
  return computeMetadataSurfaceHash({
    frontmatter: {
      tags: entry.tags,
      principles: entry.principles,
      source: entry.source,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      entrySeq: entry.entrySeq,
      related: entry.related,
    } as CanonicalFrontmatterRecord,
  });
}

export function sourceMetadataHash(entry: SourceMetadataHashInput): string {
  return computeMetadataSurfaceHash({
    frontmatter: {
      type: entry.type,
      tags: entry.tags,
      url: entry.url,
      importedAt: entry.importedAt,
      entrySeq: entry.entrySeq,
      related: entry.related,
    } as CanonicalFrontmatterRecord,
  });
}

export function wikiMetadataHash(entry: WikiMetadataHashInput): string {
  return computeMetadataSurfaceHash({
    frontmatter: {
      tags: entry.tags,
      references_principles: entry.references_principles,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      entrySeq: entry.entrySeq,
      related: entry.related,
    } as CanonicalFrontmatterRecord,
  });
}
