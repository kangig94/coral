import { createHash } from 'node:crypto';
import { sha256Hex } from '../../infra/hash.js';

/** Stable corpus identity used to coordinate projection freshness across consumers. */
export type CorpusSnapshot = {
  snapshotId: string;
  contentSeq: number;
  metadataSeq: number;
  contentManifestHash: string;
  metadataManifestHash: string;
};

export function deriveStableCorpusSnapshotId(snapshot: Omit<CorpusSnapshot, 'snapshotId'>): string {
  const digest = createHash('sha256')
    .update(
      [
        snapshot.contentSeq.toString(10),
        snapshot.metadataSeq.toString(10),
        snapshot.contentManifestHash,
        snapshot.metadataManifestHash,
      ].join('\t'),
      'utf8',
    )
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type CanonicalScalar = boolean | number | string | null | undefined;

/** Canonicalizable frontmatter value tree for manifest hashing. */
export type CanonicalFrontmatterValue =
  | CanonicalScalar
  | CanonicalFrontmatterValue[]
  | { [key: string]: CanonicalFrontmatterValue };

/** Frontmatter mapping normalized before metadata hashing. */
export type CanonicalFrontmatterRecord = Record<string, CanonicalFrontmatterValue>;

/** Minimal content surface used to compute retrieval/content manifests. */
export type ContentManifestEntry = {
  entryId: string;
  title: string;
  body: string;
};

/** Manifest row after entry bytes have been reduced to a surface hash. */
export type HashedManifestEntry = {
  manifestId: string;
  surfaceHash: string;
};

/** Parsed frontmatter metadata surface used by `computeMetadataSurfaceHash`. */
type FrontmatterMetadataSurface = {
  frontmatter: CanonicalFrontmatterRecord;
};

/** Raw-byte metadata surface for artifacts whose canonical parser is the bytes themselves. */
type RawBytesMetadataSurface = {
  rawBytes: Uint8Array | string;
};

export type MetadataSurfaceInput = FrontmatterMetadataSurface | RawBytesMetadataSurface;

// Extensibility policy: any new array-valued frontmatter field is classified as set-like or list-like at introduction; set-like fields added to canonical sort list in same PR.
export const SET_LIKE_FRONTMATTER_ARRAY_FIELDS = new Set([
  'tags',
  'principles',
  'related',
  'source',
  'members',
  'children',
]);

/** Builds the canonical retrieval text that both text and vector indexing hash/embed. */
export function buildRetrievalAuthorityText(title: string, body: string): string {
  return `# ${title}\n\n${body}`.trim();
}

/** Hashes the user-visible content surface for one entry. */
export function computeContentSurfaceHash(entry: Pick<ContentManifestEntry, 'title' | 'body'>): string {
  return sha256Hex(buildRetrievalAuthorityText(entry.title, entry.body));
}

/** Hashes either canonical frontmatter or raw bytes for metadata freshness checks. */
export function computeMetadataSurfaceHash(input: MetadataSurfaceInput): string {
  if ('frontmatter' in input) {
    return computeCanonicalFrontmatterHash(input.frontmatter);
  }

  return computeRawBytesSurfaceHash(input.rawBytes);
}

/** Produces a manifest hash that is stable across ordering changes in input iteration. */
export function computeManifestHash(entries: Iterable<HashedManifestEntry>): string {
  const byManifestId = new Map<string, string>();

  for (const entry of entries) {
    if (byManifestId.has(entry.manifestId)) {
      throw new Error(`Duplicate manifest ID: ${entry.manifestId}`);
    }
    byManifestId.set(entry.manifestId, entry.surfaceHash);
  }

  const sortedEntries = [...byManifestId.entries()].sort(([leftId], [rightId]) =>
    compareUtf8Lexicographically(leftId, rightId),
  );
  const serializedRows: string[] = [];
  for (const [manifestId, surfaceHash] of sortedEntries) {
    serializedRows.push(`${manifestId}\t${surfaceHash}`);
  }
  const serialized = serializedRows.join('\n');

  return sha256Hex(serialized);
}

/** Canonicalizes parsed frontmatter into a stable serialization for hashing. */
export function canonicalizeFrontmatter(frontmatter: CanonicalFrontmatterRecord): string {
  return canonicalizeObject(frontmatter);
}

/** Hashes canonicalized frontmatter so metadata equality is order-insensitive. */
export function computeCanonicalFrontmatterHash(frontmatter: CanonicalFrontmatterRecord): string {
  return sha256Hex(canonicalizeFrontmatter(frontmatter));
}

/** Hashes raw metadata bytes when no stronger semantic normalization exists. */
export function computeRawBytesSurfaceHash(rawBytes: Uint8Array | string): string {
  return sha256Hex(toUtf8Bytes(rawBytes));
}

/** Canonicalizes one frontmatter value, preserving list-vs-set semantics by field name. */
export function canonicalizeFrontmatterValue(value: CanonicalFrontmatterValue, fieldName?: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return JSON.stringify(value.normalize('NFC'));
  }

  if (typeof value === 'number') {
    return canonicalizeNumber(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const entry of value) {
      const canonical = canonicalizeFrontmatterValue(entry);
      if (canonical !== undefined) {
        items.push(canonical);
      }
    }

    if (fieldName !== undefined && SET_LIKE_FRONTMATTER_ARRAY_FIELDS.has(fieldName)) {
      items.sort(compareUtf8Lexicographically);
    }

    return `[${items.join(',')}]`;
  }

  return canonicalizeObject(value);
}

/** Renders numbers into a unique decimal form suitable for manifest hashing. */
export function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot canonicalize non-finite number: ${value}`);
  }

  if (Object.is(value, -0) || value === 0) {
    return '0';
  }

  const rendered = value.toString();
  if (!/[eE]/.test(rendered)) {
    return rendered;
  }

  const [mantissa, exponentText] = rendered.split(/e/i);
  const exponent = Number.parseInt(exponentText ?? '0', 10);
  const negative = mantissa.startsWith('-');
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa;
  const [integerPart, fractionPart = ''] = unsignedMantissa.split('.');
  const digits = `${integerPart}${fractionPart}`;
  const decimalIndex = integerPart.length + exponent;

  let canonical: string;
  if (decimalIndex <= 0) {
    canonical = `0.${'0'.repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    canonical = `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  } else {
    canonical = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  canonical = canonical.replace(/^0+(?=\d)/, '');
  canonical = canonical.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

  return negative ? `-${canonical}` : canonical;
}

/** Sorts strings by UTF-8 bytes so manifest ordering is locale-independent. */
export function compareUtf8Lexicographically(left: string, right: string): number {
  return Buffer.compare(toUtf8Bytes(left), toUtf8Bytes(right));
}

function canonicalizeObject(record: { [key: string]: CanonicalFrontmatterValue }): string {
  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(record)) {
    const canonicalValue = canonicalizeFrontmatterValue(value, key);
    if (canonicalValue !== undefined) {
      entries.push([key, canonicalValue] as const);
    }
  }
  entries.sort(([leftKey], [rightKey]) => compareUtf8Lexicographically(leftKey, rightKey));

  const rendered: string[] = [];
  for (const [key, value] of entries) {
    rendered.push(`${JSON.stringify(key)}:${value}`);
  }
  return `{${rendered.join(',')}}`;
}

function toUtf8Bytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
}
