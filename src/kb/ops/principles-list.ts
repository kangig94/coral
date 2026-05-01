import type { KbRuntime } from '../contract.js';
import { readKnowledgeBaseListIndex } from '../direct-read-index.js';
import {
  isNoteEntry,
  type KbIndex,
  type KbPrincipleVerboseRow,
  type KbPrinciplesInput,
  type KbPrinciplesResult,
} from '../entry-types.js';
import { compareLocale } from '../validation.js';

export function listPrinciplesFromIndex(index: KbIndex, args: KbPrinciplesInput): KbPrinciplesResult {
  const allNames = Object.keys(index.principles).sort(compareLocale);
  const total = allNames.length;
  let names = allNames;

  if (args.query?.trim()) {
    const loweredQuery = args.query.toLowerCase();
    names = allNames.filter((name) => name.toLowerCase().includes(loweredQuery));
  }

  names = names.slice(0, args.top_k ?? 100);
  if (args.verbose !== true) {
    return { principles: names, total };
  }

  const selected = new Set(names);
  const notesByPrinciple = new Map(names.map((name) => [name, [] as string[]]));
  const orphanRefs = new Set<string>();
  const noteEntries = Object.values(index.entries)
    .filter(isNoteEntry)
    .sort((left, right) => compareLocale(left.slug, right.slug));

  for (const noteRecord of noteEntries) {
    for (const principle of noteRecord.principles) {
      if (selected.has(principle)) {
        notesByPrinciple.get(principle)?.push(noteRecord.slug);
        continue;
      }

      if (!(principle in index.principles)) {
        orphanRefs.add(principle);
      }
    }
  }

  const principles: KbPrincipleVerboseRow[] = names.map((name) => ({
    name,
    statement: index.principles[name],
    notes: notesByPrinciple.get(name) ?? [],
  }));
  const warning =
    orphanRefs.size === 0 ? undefined : `Orphan principle refs: ${[...orphanRefs].sort(compareLocale).join(', ')}`;

  return {
    principles,
    total,
    ...(warning === undefined ? {} : { warning }),
  };
}

export function listPrinciples(kb: KbRuntime, args: KbPrinciplesInput): KbPrinciplesResult {
  return listPrinciplesFromIndex(readKnowledgeBaseListIndex(kb), args);
}
