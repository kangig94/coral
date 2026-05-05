import { entryIdToVaultLink, parseKbEntryId, vaultLinkToEntryId, type KbEntryId } from '../../entry-types.js';
import { assertNonEmptyText } from '../../validation.js';

export function normalizeRef(value: string, field: string): KbEntryId {
  const trimmed = assertNonEmptyText(value, field);
  const entryId = parseKbEntryId(trimmed) ?? vaultLinkToEntryId(trimmed);
  if (entryId === null) {
    throw new Error(
      `${field} must be a [[link]] (notes/sources/communities/wiki) or entry ID (note:..., source:..., community:..., wiki:...)`,
    );
  }
  return entryId;
}

export function normalizeRefs(values: readonly string[], field: string): KbEntryId[] {
  const seen = new Set<KbEntryId>();
  const unique: KbEntryId[] = [];
  for (const value of values) {
    const id = normalizeRef(value, field);
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique;
}

export function blockHeaderFor(entryId: KbEntryId): string {
  return `- ${entryIdToVaultLink(entryId)}`;
}
