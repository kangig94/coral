import { isNoEntryError } from '../../infra/fs-errors.js';
import { captureRemovedSourceManifestDeltas, captureSourceManifestDeltas } from '../corpus/manifest-authority.js';
import { extractBody, parseSourceFrontmatter, replaceSourceFrontmatter } from '../corpus/frontmatter.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../corpus/index-mutations.js';
import { buildSourceIndexEntry } from '../corpus/index-records.js';
import { readKnowledgeBaseListIndex } from '../direct-read-index.js';
import { assertWithin } from '../paths.js';
import type { KbRuntime } from '../contract.js';
import {
  deleteEntry,
  isSourceEntry,
  setEntry,
  sourceEntryId,
  type KbSourceDeleteInput,
  type KbSourceListResult,
  type SourceEntry,
} from '../entry-types.js';
import { compareLocale, assertSourceSlug } from '../validation.js';
import { currentEntrySeq } from '../index-state.js';

/** Heavy-path mutation deadline for `kb source import` — atomic markdown
 * write + manifest delta capture stays within the 30s default, but `kb source
 * import` is the documented heavy path (spec §6.4) so it opts into 5 minutes
 * to absorb large conversions / staging churn without tripping the deadline. */
export const KB_SOURCE_IMPORT_MUTATION_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function resolvePreparedSourceStagePath(kb: KbRuntime, candidate: string): string {
  const stagedPath = assertWithin(kb.sourceImportStageDir(), candidate, 'KB source staged markdown path');
  const stagedStat = kb.storagePort.lstatSync(stagedPath);
  if (stagedStat.isSymbolicLink()) {
    throw new Error('KB source staged markdown path must not be a symlink');
  }
  if (!stagedStat.isFile()) {
    throw new Error('KB source staged markdown path must be a file');
  }

  return assertWithin(
    kb.storagePort.realpathSync(kb.sourceImportStageDir()),
    kb.storagePort.realpathSync(stagedPath),
    'KB source staged markdown path',
  );
}

export async function persistPreparedSource(
  kb: KbRuntime,
  stagedPath: string,
  slug: string,
  options?: { signal?: AbortSignal },
): Promise<{ slug: string; path: string }> {
  // The caller's signal threads into `withMutationLock` so the `'persist'`
  // critical section receives a composed (caller + deadline) signal. The
  // service-level `'persist'` fence above this call covers the pre-lock
  // checkpoint; downstream `fn` body work is non-cancellable filesystem I/O
  // by design (atomic write either commits or rolls back).
  const normalizedSlug = assertSourceSlug(slug, 'source');
  const signal = options?.signal;

  return kb.withMutationLock(
    async (mutation) => {
      const filePath = kb.sourcePath(normalizedSlug);
      const principlePath = kb.principlePath(normalizedSlug);
      const stagedCandidate = assertWithin(kb.sourceImportStageDir(), stagedPath, 'KB source staged markdown path');

      if (kb.storagePort.existsSync(filePath)) {
        throw new Error(`KB source already exists: ${filePath}`);
      }

      if (kb.storagePort.existsSync(principlePath)) {
        throw new Error(`KB principle already exists: ${principlePath}`);
      }

      try {
        const resolvedStagedPath = resolvePreparedSourceStagePath(kb, stagedCandidate);
        const renderedSource = kb.storagePort.readFileSync(resolvedStagedPath, 'utf-8');
        const parsedMeta = parseSourceFrontmatter(renderedSource);
        const entrySeq = currentEntrySeq(kb.readIndexState()) + 1;
        const persistedMeta = {
          ...parsedMeta,
          entrySeq,
        };
        const persistedSource = replaceSourceFrontmatter(renderedSource, persistedMeta);

        writeFileAtomic(kb, filePath, persistedSource);
        mutation.queueManifestAuthorityDelta(captureSourceManifestDeltas(normalizedSlug, persistedSource));

        commitIndexUpdate(kb, (index) => {
          setEntry(
            index,
            sourceEntryId(normalizedSlug),
            buildSourceIndexEntry({
              slug: normalizedSlug,
              body: extractBody(persistedSource),
              ...persistedMeta,
            }),
          );
        });
        recordContentAndMetadataMutation(kb, 'KB text snapshot is stale after kb_source_import.');
      } finally {
        kb.storagePort.rmSync(stagedCandidate, { force: true });
      }

      return { slug: normalizedSlug, path: filePath };
    },
    {
      timeoutMs: KB_SOURCE_IMPORT_MUTATION_LOCK_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

export async function deleteSource(rt: KbRuntime, input: KbSourceDeleteInput): Promise<{ deleted: string }> {
  const slug = assertSourceSlug(input.slug, 'source');
  const sourcePath = rt.sourcePath(slug);

  return rt.withMutationLock(async (mutation) => {
    try {
      rt.storagePort.rmSync(sourcePath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        throw new Error(`KB source not found: ${slug}`, { cause: error });
      }
      throw error;
    }

    mutation.queueManifestAuthorityDelta(captureRemovedSourceManifestDeltas(slug));
    recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_source_delete.');
    commitIndexUpdate(rt, (index) => {
      deleteEntry(index, sourceEntryId(slug));
    });

    return { deleted: sourcePath };
  });
}

export async function listSources(kb: KbRuntime): Promise<KbSourceListResult> {
  const index = readKnowledgeBaseListIndex(kb);
  const entries: SourceEntry[] = [];
  for (const entry of Object.values(index.entries)) {
    if (isSourceEntry(entry)) {
      entries.push(entry);
    }
  }
  entries.sort((left, right) => compareLocale(left.slug, right.slug));

  const sources: KbSourceListResult['sources'] = [];
  for (const entry of entries) {
    sources.push({
      slug: entry.slug,
      title: entry.title,
      type: entry.type,
      tags: [...entry.tags],
      ...(entry.url === undefined ? {} : { url: entry.url }),
      importedAt: entry.importedAt,
    });
  }

  return { sources };
}
