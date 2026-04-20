import { readFileSync } from 'node:fs';
import type { KbRuntime } from '../contracts.js';
import { rewriteLegacyNoteFrontmatter } from './frontmatter.js';
import { sortedMarkdownEntries } from './markdown-entries.js';
import { writeFileAtomic } from './mutation-helpers.js';
import { stripMdExt } from '../paths.js';

export type EntrySeqGuardTarget = Pick<KbRuntime, 'notePath' | 'notesDir'>;

/**
 * Rewrite legacy `mutationSeqAtPromote` frontmatter to `entrySeq`.
 * Idempotent: rewrites only files that still have the legacy key, so
 * a second invocation is a no-op and does not change directory mtimes.
 * This means it cannot cause a rebuild loop even though it runs before
 * the freshness check in `ensureIndex()`.
 */
export function runEntrySeqUpgradeGuard(target: EntrySeqGuardTarget): boolean {
  let changed = false;

  for (const entry of sortedMarkdownEntries(target.notesDir())) {
    const notePath = target.notePath(stripMdExt(entry));
    const raw = readFileSync(notePath, 'utf-8');
    let rewritten: string | null;

    try {
      rewritten = rewriteLegacyNoteFrontmatter(raw);
    } catch {
      continue;
    }

    if (rewritten === null) {
      continue;
    }

    writeFileAtomic(notePath, rewritten);
    changed = true;
  }

  return changed;
}
