import type { KbRuntime, KbTextArtifactsSnapshot } from '../contracts.js';
import { emptyIndex } from '../corpus/index-store.js';
import { isNoteEntry, isSourceEntry, noteEntryId, sourceEntryId } from '../entry-types.js';
import { loadKbNote, loadKbSource } from '../read.js';

type TextArtifactsRuntime = Pick<KbRuntime, 'notePath' | 'readIndex' | 'sourcePath'>;

export type RebuiltTextArtifacts = {
  notes: Array<{ note: string; body: string }>;
  sources: Array<{ slug: string; body: string }>;
};

export function captureTextArtifactsSnapshot(kb: TextArtifactsRuntime): KbTextArtifactsSnapshot {
  const index = kb.readIndex() ?? emptyIndex();
  const notes: KbTextArtifactsSnapshot['notes'] = [];
  const sources: KbTextArtifactsSnapshot['sources'] = [];

  for (const entry of Object.values(index.entries)) {
    if (isNoteEntry(entry)) {
      notes.push({
        entry,
        body: loadKbNote(kb.notePath(entry.slug)).body,
      });
      continue;
    }

    if (isSourceEntry(entry)) {
      sources.push({
        entry,
        body: loadKbSource(kb.sourcePath(entry.slug)).body,
      });
    }
  }

  return { index, notes, sources };
}

export function textArtifactsSnapshotFromRebuildResult(
  kb: TextArtifactsRuntime,
  result: RebuiltTextArtifacts,
): KbTextArtifactsSnapshot {
  const index = kb.readIndex() ?? emptyIndex();
  const notes: KbTextArtifactsSnapshot['notes'] = [];
  const sources: KbTextArtifactsSnapshot['sources'] = [];

  for (const note of result.notes) {
    const entry = index.entries[noteEntryId(note.note)];
    if (entry !== undefined && isNoteEntry(entry)) {
      notes.push({ entry, body: note.body });
    }
  }
  for (const source of result.sources) {
    const entry = index.entries[sourceEntryId(source.slug)];
    if (entry !== undefined && isSourceEntry(entry)) {
      sources.push({ entry, body: source.body });
    }
  }

  return { index, notes, sources };
}
