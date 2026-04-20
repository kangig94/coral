import { createHash } from 'node:crypto';

/** Stable corpus identity used to coordinate projection freshness across consumers. */
export type CorpusSnapshot = {
  snapshotId: string;
  contentSeq: number;
  metadataSeq: number;
  contentManifestHash: string;
  metadataManifestHash: string;
};

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

/** Parsed frontmatter metadata surface for manifest hashing. */
export type FrontmatterMetadataManifestInput = {
  manifestId: string;
  frontmatter: CanonicalFrontmatterRecord;
};

/** Raw-byte metadata surface for artifacts whose canonical parser is the bytes themselves. */
export type RawBytesMetadataManifestInput = {
  manifestId: string;
  rawBytes: Uint8Array | string;
};

export type MetadataManifestInput = FrontmatterMetadataManifestInput | RawBytesMetadataManifestInput;
export type MetadataSurfaceInput = Omit<FrontmatterMetadataManifestInput, 'manifestId'> | Omit<RawBytesMetadataManifestInput, 'manifestId'>;

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

/** Folds content entry hashes into one deterministic content manifest hash. */
export function computeContentManifestHash(entries: Iterable<ContentManifestEntry>): string {
  return computeManifestHash(
    mapIterable(entries, (entry) => ({
      manifestId: entry.entryId,
      surfaceHash: computeContentSurfaceHash(entry),
    })),
  );
}

/** Hashes either canonical frontmatter or raw bytes for metadata freshness checks. */
export function computeMetadataSurfaceHash(input: MetadataSurfaceInput): string {
  if ('frontmatter' in input) {
    return computeCanonicalFrontmatterHash(input.frontmatter);
  }

  return computeRawBytesSurfaceHash(input.rawBytes);
}

/** Folds metadata surfaces into one deterministic metadata manifest hash. */
export function computeMetadataManifestHash(metadataInputs: Iterable<MetadataManifestInput>): string {
  return computeManifestHash(
    mapIterable(metadataInputs, (input) => ({
      manifestId: input.manifestId,
      surfaceHash: computeMetadataSurfaceHash(input),
    })),
  );
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

  const serialized = [...byManifestId.entries()]
    .sort(([leftId], [rightId]) => compareUtf8Lexicographically(leftId, rightId))
    .map(([manifestId, surfaceHash]) => `${manifestId}\t${surfaceHash}`)
    .join('\n');

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
export function canonicalizeFrontmatterValue(
  value: CanonicalFrontmatterValue,
  fieldName?: string,
): string | undefined {
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
    const items = value
      .map((entry) => canonicalizeFrontmatterValue(entry))
      .filter((entry): entry is string => entry !== undefined);

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
  const entries = Object.entries(record)
    .map(([key, value]) => {
      const canonicalValue = canonicalizeFrontmatterValue(value, key);
      return canonicalValue === undefined ? null : [key, canonicalValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null)
    .sort(([leftKey], [rightKey]) => compareUtf8Lexicographically(leftKey, rightKey));

  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;
}

function mapIterable<TInput, TOutput>(
  iterable: Iterable<TInput>,
  mapper: (value: TInput) => TOutput,
): Iterable<TOutput> {
  return {
    *[Symbol.iterator]() {
      for (const value of iterable) {
        yield mapper(value);
      }
    },
  };
}

function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function toUtf8Bytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
}
