import { nowIsoString } from '../../infra/time.js';
import { captureNoteManifestDeltas } from '../corpus/manifest-authority.js';
import { parseMemoFrontmatter, serializeNote } from '../corpus/frontmatter.js';
import { memoPathFromContext } from '../paths.js';
import { noteEntryId, setEntry, type KbPromoteInput } from '../entry-types.js';
import { assertNonEmptyText, assertNoteSlug, assertSlug } from '../validation.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../corpus/index-mutations.js';
import { buildNoteIndexEntry } from '../corpus/index-records.js';
import type { KbRuntime } from '../contract.js';
import { currentEntrySeq } from '../index-state.js';

export async function promote(
  rt: KbRuntime,
  projectRoot: string,
  input: KbPromoteInput,
  onSchedule?: () => void,
): Promise<{ path: string }> {
  const memo = assertNonEmptyText(input.memo, 'memo');
  const title = assertNonEmptyText(input.title, 'title');
  if (typeof input.content !== 'string') {
    throw new Error('content must be a string');
  }
  const content = input.content;
  const domain = assertSlug(input.domain, 'domain');
  const topic = assertNoteSlug(input.topic, 'topic');

  let memoPath = memoPathFromContext(projectRoot, memo);
  if (!rt.storagePort.existsSync(memoPath) && !memo.endsWith('.md')) {
    memoPath = memoPathFromContext(projectRoot, `${memo}.md`);
  }
  if (!rt.storagePort.existsSync(memoPath)) {
    throw new Error(`Memo file not found: ${memoPath}`);
  }
  const noteSlug = `${domain}-${topic}`;
  const notePath = rt.notePath(noteSlug);

  const result = await rt.withMutationLock(async (mutation) => {
    if (rt.storagePort.existsSync(notePath)) {
      throw new Error(`KB note already exists: ${notePath}`);
    }
    const { noteRaw, noteMeta } = buildPromotedNoteFromMemo(rt, { memoPath, domain, title, content });
    writeFileAtomic(rt, notePath, noteRaw);
    mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(noteSlug, noteRaw));
    commitIndexUpdate(rt, (index) => {
      setEntry(index, noteEntryId(noteSlug), buildNoteIndexEntry({ slug: noteSlug, title, ...noteMeta }));
    });
    recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_promote.');
    rt.storagePort.rmSync(memoPath, { force: true });
    return { path: notePath };
  });

  onSchedule?.();
  return result;
}

export interface PromotedNoteMeta {
  tags: string[];
  principles: string[];
  source: string[];
  createdAt: string;
  updatedAt: string;
  related: string[];
  entrySeq: number;
}

interface BuildPromotedNoteInput {
  memoPath: string;
  domain: string;
  title: string;
  content: string;
}

export function buildPromotedNoteFromMemo(
  rt: KbRuntime,
  input: BuildPromotedNoteInput,
): { noteRaw: string; noteMeta: PromotedNoteMeta } {
  const memoContent = rt.storagePort.readFileSync(input.memoPath, 'utf-8');
  const { source } = parseMemoFrontmatter(memoContent);
  const entrySeq = currentEntrySeq(rt.readIndexState()) + 1;
  const createdAt = nowIsoString(rt.time);
  const noteMeta: PromotedNoteMeta = {
    tags: [input.domain],
    principles: [],
    source,
    createdAt,
    updatedAt: createdAt,
    related: [],
    entrySeq,
  };
  const noteRaw = serializeNote(noteMeta, input.title, input.content);
  return { noteRaw, noteMeta };
}
