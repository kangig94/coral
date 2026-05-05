import { isNoEntryError } from '../infra/fs-errors.js';
import { errorMessage } from '../infra/error-format.js';
import { backendLog } from '../infra/backend-log.js';
import { areCommunityDocumentsFresh } from './curate/community/freshness.js';
import { extractBody, parseCommunityFrontmatter, parseWikiBody, parseWikiFrontmatter } from './corpus/frontmatter.js';
import { isCommunityEntry, isNoteEntry, isSourceEntry, isWikiEntry, type KbIndex } from './entry-types.js';
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
  'readIndexOrEmpty' | 'storagePort' | 'notePath' | 'sourcePath' | 'communityPath' | 'wikiPath'
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

  if (isWikiEntry(entry)) {
    try {
      const rawContent = kb.storagePort.readFileSync(kb.wikiPath(entry.slug), 'utf-8');
      parseWikiFrontmatter(rawContent);
      const body = extractBody(rawContent);
      parseWikiBody(body);
      return {
        kind: 'wiki',
        entry,
        body,
        rawContent,
      };
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      backendLog.warn(`Skipping malformed KB wiki ${entry.slug}.md in projection input: ${errorMessage(error)}`);
      return null;
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
  const generatedCommunityDocs = new Map<string, KbGeneratedCommunityDocument>();
  for (const document of options.generatedCommunityDocs ?? []) {
    generatedCommunityDocs.set(document.slug, document);
  }

  const entryIds = Object.keys(index.entries).sort((left, right) => left.localeCompare(right));
  const records: KbProjectionRecord[] = [];
  for (const entryId of entryIds) {
    const record = materializeProjectionRecord(kb, index.entries[entryId], generatedCommunityDocs);
    if (record !== null) {
      records.push(record);
    }
  }

  return {
    index,
    records,
    communityFresh: options.forceCommunityFresh ?? areCommunityDocumentsFresh(kb as KbRuntime, index),
  };
}
