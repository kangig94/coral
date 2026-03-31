import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isNoEntryError } from '../shared/mcp-utils.js';
import { parseSourceFrontmatter } from './frontmatter.js';
import { buildSourceIndexEntry, commitIndexUpdate, writeFileAtomic } from './mutation-helpers.js';
import { assertWithin } from './paths.js';
import type { KbRuntime } from './runtime.js';
import { deleteEntry, isSourceEntry, setEntry, sourceEntryId, type KbSourceDeleteInput, type KbSourceFrontmatter, type KbSourceListResult } from './types.js';
import { compareLocale, assertSourceSlug } from './validation.js';

function resolvePreparedSourceStagePath(kb: KbRuntime, candidate: string): string {
  const stagedPath = assertWithin(kb.sourceImportStageDir(), candidate, 'KB source staged markdown path');
  const stagedStat = lstatSync(stagedPath);
  if (stagedStat.isSymbolicLink()) {
    throw new Error('KB source staged markdown path must not be a symlink');
  }
  if (!stagedStat.isFile()) {
    throw new Error('KB source staged markdown path must be a file');
  }

  return assertWithin(
    realpathSync(kb.sourceImportStageDir()),
    realpathSync(stagedPath),
    'KB source staged markdown path',
  );
}

export async function persistPreparedSource(
  kb: KbRuntime,
  stagedPath: string,
  slug: string,
  meta: KbSourceFrontmatter,
): Promise<{ slug: string; path: string }> {
  void meta;
  const normalizedSlug = assertSourceSlug(slug, 'source');

  return kb.withMutationLock(async () => {
    const filePath = kb.sourcePath(normalizedSlug);
    const principlePath = kb.principlePath(normalizedSlug);
    const stagedCandidate = assertWithin(kb.sourceImportStageDir(), stagedPath, 'KB source staged markdown path');

    if (existsSync(filePath)) {
      throw new Error(`KB source already exists: ${filePath}`);
    }

    if (existsSync(principlePath)) {
      throw new Error(`KB principle already exists: ${principlePath}`);
    }

    try {
      const resolvedStagedPath = resolvePreparedSourceStagePath(kb, stagedCandidate);
      const renderedSource = readFileSync(resolvedStagedPath, 'utf-8');
      const parsedMeta = parseSourceFrontmatter(renderedSource);

      writeFileAtomic(filePath, renderedSource);
      kb.recordMutationCommitted();

      commitIndexUpdate(
        kb,
        (index) => {
          setEntry(index, sourceEntryId(normalizedSlug), buildSourceIndexEntry({
            slug: normalizedSlug,
            ...parsedMeta,
          }));
        },
        'KB text snapshot is stale after kb_source_import.',
      );
    } finally {
      rmSync(stagedCandidate, { force: true });
    }

    return { slug: normalizedSlug, path: filePath };
  });
}

export async function deleteSource(rt: KbRuntime, input: KbSourceDeleteInput): Promise<{ deleted: string }> {
  const slug = assertSourceSlug(input.slug, 'source');
  const sourcePath = rt.sourcePath(slug);

  return rt.withMutationLock(async () => {
    try {
      rmSync(sourcePath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        throw new Error(`KB source not found: ${slug}`, { cause: error });
      }
      throw error;
    }

    rt.recordMutationCommitted();
    commitIndexUpdate(
      rt,
      (index) => {
        deleteEntry(index, sourceEntryId(slug));
      },
      'KB text snapshot is stale after kb_source_delete.',
    );

    return { deleted: sourcePath };
  });
}

export async function listSources(kb: KbRuntime): Promise<KbSourceListResult> {
  const index = kb.readIndex() ?? (await kb.ensureIndex());
  const sources = Object.values(index.entries)
    .filter(isSourceEntry)
    .sort((left, right) => compareLocale(left.slug, right.slug))
    .map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      type: entry.type,
      tags: [...entry.tags],
      ...(entry.url === undefined ? {} : { url: entry.url }),
      importedAt: entry.importedAt,
    }));

  return { sources };
}
