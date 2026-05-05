import type { KbRuntime } from '../contract.js';
import { readKnowledgeBaseListIndex } from '../direct-read-index.js';
import {
  isNoteEntry,
  type KbIndex,
  type NoteEntry,
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
    names = [];
    for (const name of allNames) {
      if (name.toLowerCase().includes(loweredQuery)) {
        names.push(name);
      }
    }
  }

  names = names.slice(0, args.top_k ?? 100);
  if (args.verbose !== true) {
    return { principles: names, total };
  }

  const selected = new Set(names);
  const notesByPrinciple = new Map<string, string[]>();
  for (const name of names) {
    notesByPrinciple.set(name, []);
  }
  const orphanRefs = new Set<string>();
  const noteEntries: NoteEntry[] = [];
  for (const entry of Object.values(index.entries)) {
    if (isNoteEntry(entry)) {
      noteEntries.push(entry);
    }
  }
  noteEntries.sort((left, right) => compareLocale(left.slug, right.slug));

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

  const principles: KbPrincipleVerboseRow[] = [];
  for (const name of names) {
    principles.push({
      name,
      statement: index.principles[name],
      notes: notesByPrinciple.get(name) ?? [],
    });
  }
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
