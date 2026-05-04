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

// `project` is intentionally excluded from this hash. `wikiMetadataHash` covers
// the index-record fields consumed by `authority-baseline.ts` / `drift.ts` /
// `engines/orama/backend.ts` — a separate surface from the full-frontmatter hash
// computed by `inbound-sync.ts`'s `computeMetadataSurfaceHash` (which does include
// `project`). The two surfaces are never directly compared, so this asymmetry is
// benign; `project` is set-once at create time and has no update path.
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
