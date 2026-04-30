// Engine-blind text helpers consumed by KB-tier search assembly.
// Trimmed whitespace normalization and slug denormalization stay out of
// engine internals so engine swaps do not require KB-tier rewrites.

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function denormalizeSlug(slug: string): string {
  return slug.replace(/ /g, '-');
}
