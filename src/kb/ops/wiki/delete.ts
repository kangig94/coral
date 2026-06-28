import { isNoEntryError } from '../../../infra/fs-errors.js';
import { captureRemovedWikiManifestDeltas } from '../../corpus/manifest-authority.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../../corpus/index/mutations.js';
import { deleteEntry, wikiEntryId, type KbWikiDeleteInput, type KbWikiDeleteResponse } from '../../entry-types.js';
import { assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';

export async function deleteWiki(rt: KbRuntime, input: KbWikiDeleteInput): Promise<KbWikiDeleteResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const wikiPath = rt.wikiPath(slug);

  return rt.withMutationLock(async (mutation) => {
    try {
      rt.storagePort.rmSync(wikiPath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        throw new Error(`KB wiki not found: ${slug}`, { cause: error });
      }
      throw error;
    }

    mutation.queueManifestAuthorityDelta(captureRemovedWikiManifestDeltas(slug));
    commitIndexUpdate(rt, (index) => {
      deleteEntry(index, wikiEntryId(slug));
    });
    recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_wiki_delete.');

    return { deleted: wikiPath };
  });
}
