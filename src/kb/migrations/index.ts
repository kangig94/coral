// TEMPORARY KB MIGRATION — REMOVE AFTER ~2026-07 (≈1 month post-rollout). To remove: delete src/kb/migrations/ and the call site in src/kb/curate/scheduler.ts. The version marker then becomes inert.
import { dirname, join } from 'node:path';

import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import { extractBody, replaceFrontmatter, replaceSourceFrontmatter } from '../corpus/frontmatter.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { sortedMarkdownEntries } from '../corpus/markdown-entries.js';
import { computeBodySurfaceHash } from '../corpus/snapshot.js';
import type { KbRuntime } from '../contract.js';
import type { KbNoteFrontmatter, KbSourceFrontmatter } from '../entry-types.js';
import { stripMdExt } from '../paths.js';
import { loadKbNote, loadKbSource } from '../read.js';
import { KB_RUNTIME_AUTHORITY } from '../../runtime/kb-runtime-authority.js';

const CURRENT_KB_MIGRATION_VERSION = 1;
const VERSION_MARKER_PATH = [KB_RUNTIME_AUTHORITY.migrations, 'kb-version.json'] as const;

function markerPath(kb: Pick<KbRuntime, 'runtimeDir'>): string {
  return join(kb.runtimeDir, ...VERSION_MARKER_PATH);
}

function readAppliedMigrationVersion(kb: Pick<KbRuntime, 'runtimeDir' | 'storagePort'>): number {
  const path = markerPath(kb);
  if (!kb.storagePort.existsSync(path)) {
    return 0;
  }

  try {
    const parsed = JSON.parse(kb.storagePort.readFileSync(path, 'utf-8')) as unknown;
    if (isRecord(parsed) && typeof parsed.version === 'number' && Number.isInteger(parsed.version)) {
      return parsed.version;
    }
  } catch {
    // Treat corrupt markers as stale; the next successful run rewrites them.
  }
  return 0;
}

function writeAppliedMigrationVersion(kb: Pick<KbRuntime, 'runtimeDir' | 'storagePort'>): void {
  const path = markerPath(kb);
  kb.storagePort.mkdirSync(dirname(path), { recursive: true });
  const wrote = kb.storagePort.writeAtomicSync(path, `${JSON.stringify({ version: CURRENT_KB_MIGRATION_VERSION })}\n`, {
    encoding: 'utf-8',
  });
  if (!wrote) {
    throw new Error(`Could not write KB migration marker: ${path}`);
  }
}

function noteHasClassificationMetadata(frontmatter: KbNoteFrontmatter): boolean {
  return frontmatter.principles.length > 0 || (frontmatter.related ?? []).length > 0;
}

function sourceHasClassificationMetadata(frontmatter: KbSourceFrontmatter): boolean {
  return frontmatter.tags.length > 0 || (frontmatter.related ?? []).length > 0;
}

function backfillNoteInputFingerprint(kb: KbRuntime, note: string): boolean {
  const path = kb.notePath(note);
  const loaded = loadKbNote(kb.storagePort, path);
  if (loaded.frontmatter.inputFingerprint !== undefined) {
    return false;
  }
  if (!noteHasClassificationMetadata(loaded.frontmatter)) {
    return false;
  }

  const inputFingerprint = computeBodySurfaceHash(extractBody(loaded.raw));
  writeFileAtomic(
    kb,
    path,
    replaceFrontmatter(loaded.raw, {
      ...loaded.frontmatter,
      inputFingerprint,
    }),
  );
  return true;
}

function backfillSourceInputFingerprint(kb: KbRuntime, slug: string): boolean {
  const path = kb.sourcePath(slug);
  const loaded = loadKbSource(kb.storagePort, path);
  if (loaded.frontmatter.inputFingerprint !== undefined) {
    return false;
  }
  if (!sourceHasClassificationMetadata(loaded.frontmatter)) {
    return false;
  }

  const inputFingerprint = computeBodySurfaceHash(extractBody(loaded.raw));
  writeFileAtomic(
    kb,
    path,
    replaceSourceFrontmatter(loaded.raw, {
      ...loaded.frontmatter,
      inputFingerprint,
    }),
  );
  return true;
}

function backfillCuratedInputFingerprints(kb: KbRuntime): boolean {
  let changed = false;

  for (const entry of sortedMarkdownEntries(kb.storagePort, kb.notesDir())) {
    const note = stripMdExt(entry);
    try {
      changed = backfillNoteInputFingerprint(kb, note) || changed;
    } catch (error: unknown) {
      backendLog.warn(`kb_migration: skipping note ${note} during inputFingerprint backfill: ${errorMessage(error)}`);
    }
  }

  for (const entry of sortedMarkdownEntries(kb.storagePort, kb.sourcesDir())) {
    const source = stripMdExt(entry);
    try {
      changed = backfillSourceInputFingerprint(kb, source) || changed;
    } catch (error: unknown) {
      backendLog.warn(
        `kb_migration: skipping source ${source} during inputFingerprint backfill: ${errorMessage(error)}`,
      );
    }
  }

  return changed;
}

async function applyCurrentMigration(kb: KbRuntime): Promise<void> {
  const changed = await kb.withMutationLock(() => backfillCuratedInputFingerprints(kb));
  if (changed) {
    kb.invalidateKbCache();
  }
}

export async function runPendingKbMigrations(kb: KbRuntime): Promise<void> {
  try {
    const appliedVersion = readAppliedMigrationVersion(kb);
    if (appliedVersion >= CURRENT_KB_MIGRATION_VERSION) {
      return;
    }

    await applyCurrentMigration(kb);
    writeAppliedMigrationVersion(kb);
  } catch (error: unknown) {
    backendLog.error('kb_migration: migration failed; continuing KB access', error);
  }
}
