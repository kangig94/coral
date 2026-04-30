import { isNoEntryError } from '../infra/fs-errors.js';
import { areCommunityDocumentsFresh } from './curate/community/freshness.js';
import { extractBody, parseCommunityFrontmatter } from './corpus/frontmatter.js';
import { isCommunityEntry, isNoteEntry, isSourceEntry, type KbIndex } from './entry-types.js';
import { loadKbNote, loadKbSource } from './read.js';
import type { KbRuntime } from './contract.js';
import type {
  KbGeneratedCommunityDocument,
  KbProjectionInput,
  KbProjectionInputOptions,
  KbProjectionRecord,
} from './projection-input-contract.js';

type ProjectionInputRuntime = Pick<
  KbRuntime,
  'readIndexOrEmpty' | 'storagePort' | 'notePath' | 'sourcePath' | 'communityPath'
>;

function materializeProjectionRecord(
  kb: ProjectionInputRuntime,
  entry: KbIndex['entries'][string] | undefined,
  generatedCommunityDocs: ReadonlyMap<string, KbGeneratedCommunityDocument>,
): KbProjectionRecord | null {
  if (entry === undefined) {
    return null;
  }

  if (isNoteEntry(entry)) {
    try {
      return {
        kind: 'note',
        entry,
        body: loadKbNote(kb.storagePort, kb.notePath(entry.slug)).body,
      };
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      throw error;
    }
  }

  if (isSourceEntry(entry)) {
    try {
      return {
        kind: 'source',
        entry,
        body: loadKbSource(kb.storagePort, kb.sourcePath(entry.slug)).body,
      };
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      throw error;
    }
  }

  if (!isCommunityEntry(entry)) {
    return null;
  }

  const generated = generatedCommunityDocs.get(entry.slug);
  if (generated !== undefined) {
    return {
      kind: 'community',
      entry,
      body: extractBody(generated.content),
      rawContent: generated.content,
    };
  }

  const rawContent = kb.storagePort.readFileSync(kb.communityPath(entry.slug), 'utf-8');
  parseCommunityFrontmatter(rawContent);
  return {
    kind: 'community',
    entry,
    body: extractBody(rawContent),
    rawContent,
  };
}

export function createKbProjectionInput(
  kb: ProjectionInputRuntime,
  options: KbProjectionInputOptions = {},
): KbProjectionInput {
  const index = options.index ?? kb.readIndexOrEmpty();
  const generatedCommunityDocs = new Map(
    (options.generatedCommunityDocs ?? []).map((document) => [document.slug, document] as const),
  );
  const records = Object.entries(index.entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => materializeProjectionRecord(kb, entry, generatedCommunityDocs))
    .filter((record): record is KbProjectionRecord => record !== null);

  return {
    index,
    records,
    communityFresh: options.forceCommunityFresh ?? areCommunityDocumentsFresh(kb as KbRuntime, index),
  };
}
