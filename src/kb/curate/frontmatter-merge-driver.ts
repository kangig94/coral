import { basename, join } from 'node:path';

import { classifyThrownExecOutcome } from '../../infra/port-types.js';
import {
  extractBody,
  parseCommunityFrontmatter,
  parseFrontmatter,
  parseSourceFrontmatter,
  parseWikiFrontmatter,
  serializeCommunityFrontmatter,
  serializeFrontmatter,
  serializeSourceFrontmatter,
  serializeWikiFrontmatter,
} from '../corpus/frontmatter.js';
import { computeBodySurfaceHash, normalizeContentBody } from '../corpus/snapshot.js';
import type { KbNoteFrontmatter, KbSourceFrontmatter } from '../entry-types.js';
import { compareLocale } from '../validation.js';
import { uniqueTrimmedList } from './content-normalize.js';

const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export const FRONTMATTER_SCALAR_TIEBREAK_RULE =
  'If scalar fingerprints differ, keep the equal value when present; otherwise inputFingerprint matching the merged normalized body wins; otherwise the side whose body matches the merged body wins; otherwise choose the lexicographically greatest defined value. updatedAt uses the lexicographic maximum.';

export type FrontmatterMergeDriverPaths = {
  basePath: string;
  oursPath: string;
  theirsPath: string;
  filePath?: string;
};

export type FrontmatterMergeDriverResult = {
  status: number;
  bodyConflict: boolean;
};

/**
 * `git merge-file` runs synchronously in the CLI process on three local temp files this driver just wrote, so
 * it should finish in milliseconds; the bound exists because a synchronous subprocess that does not finish
 * cannot be interrupted by anything, not because this one is expected to be slow.
 *
 * `timeout` is required rather than optional on `FrontmatterMergeDriverHost` below. An optional bound here would be no bound:
 * this host is constructed in `cli/commands/kb.ts`, which forwards whatever it is handed, and
 * `tests/invariants/sync-subprocess-timeout.test.ts` would then have had to exempt that adapter — which it did,
 * on the stated premise that the caller supplies the bound. The caller could not: the type forbade it.
 */
const GIT_MERGE_FILE_TIMEOUT_MS = 2_000;

export type FrontmatterMergeDriverHost = {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string, encoding: 'utf-8'): void;
  createTempDir(prefix: string): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  execFileSync(command: string, args: string[], options: { stdio: 'ignore'; timeout: number }): Buffer | string;
};

type MarkdownDocument = {
  frontmatterBlock: string;
  body: string;
  raw: string;
};

type BodyMergeContext = {
  oursBody: string;
  theirsBody: string;
  mergedBody: string;
  mergedBodyInputFingerprint: string;
};

type MarkdownKind = 'note' | 'source' | 'community' | 'wiki' | 'unknown';

export function runFrontmatterMergeDriver(
  paths: FrontmatterMergeDriverPaths,
  host: FrontmatterMergeDriverHost,
): FrontmatterMergeDriverResult {
  const base = splitMarkdownDocument(host.readFileSync(paths.basePath, 'utf-8'));
  const ours = splitMarkdownDocument(host.readFileSync(paths.oursPath, 'utf-8'));
  const theirs = splitMarkdownDocument(host.readFileSync(paths.theirsPath, 'utf-8'));
  const label = paths.filePath ?? basename(paths.oursPath);
  const bodyMerge = mergeBodiesWithGit(base.body, ours.body, theirs.body, label, host);
  const mergedFrontmatter = mergeFrontmatter(ours, theirs, bodyMerge.body, paths.filePath ?? paths.oursPath);

  host.writeFileSync(paths.oursPath, `${mergedFrontmatter}${bodyMerge.body}`, 'utf-8');
  return {
    status: bodyMerge.status,
    bodyConflict: bodyMerge.status !== 0,
  };
}

export function mergeMarkdownRevisions(
  baseContent: string,
  oursContent: string,
  theirsContent: string,
  filePath: string,
  host: FrontmatterMergeDriverHost,
): { content: string; result: FrontmatterMergeDriverResult } {
  const tempDir = host.createTempDir('coral-frontmatter-driver-');
  const basePath = join(tempDir, 'base.md');
  const oursPath = join(tempDir, 'ours.md');
  const theirsPath = join(tempDir, 'theirs.md');

  try {
    host.writeFileSync(basePath, baseContent, 'utf-8');
    host.writeFileSync(oursPath, oursContent, 'utf-8');
    host.writeFileSync(theirsPath, theirsContent, 'utf-8');
    const result = runFrontmatterMergeDriver({ basePath, oursPath, theirsPath, filePath }, host);
    return {
      content: host.readFileSync(oursPath, 'utf-8'),
      result,
    };
  } finally {
    host.rmSync(tempDir, { recursive: true, force: true });
  }
}

function splitMarkdownDocument(content: string): MarkdownDocument {
  const match = content.match(FRONTMATTER_BLOCK_PATTERN);
  if (match === null) {
    return {
      frontmatterBlock: '',
      body: content,
      raw: content,
    };
  }

  return {
    frontmatterBlock: match[0],
    body: content.slice(match[0].length),
    raw: content,
  };
}

function mergeBodiesWithGit(
  baseBody: string,
  oursBody: string,
  theirsBody: string,
  label: string,
  host: FrontmatterMergeDriverHost,
): { body: string; status: number } {
  const tempDir = host.createTempDir('coral-frontmatter-body-');
  const basePath = join(tempDir, 'base.md');
  const oursPath = join(tempDir, 'ours.md');
  const theirsPath = join(tempDir, 'theirs.md');

  try {
    host.writeFileSync(basePath, baseBody, 'utf-8');
    host.writeFileSync(oursPath, oursBody, 'utf-8');
    host.writeFileSync(theirsPath, theirsBody, 'utf-8');

    let status = 0;
    try {
      host.execFileSync(
        'git',
        [
          'merge-file',
          '-L',
          `${label} (ours)`,
          '-L',
          `${label} (base)`,
          '-L',
          `${label} (theirs)`,
          oursPath,
          basePath,
          theirsPath,
        ],
        { stdio: 'ignore', timeout: GIT_MERGE_FILE_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      const outcome = classifyMergeFileFailure(error);
      // Raised rather than returned, because there is no exit status that means "do not write the file" — every
      // number this function can produce is a merge result the caller acts on.
      if (outcome.kind === 'no-answer') throw new FrontmatterMergeUnavailableError(label, outcome.detail);
      status = outcome.status;
    }

    return {
      body: host.readFileSync(oursPath, 'utf-8'),
      status,
    };
  } finally {
    host.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Raised when `git merge-file` did not answer, so nothing may be written to git's `%A`.
 *
 * The message names the exit because the state it leaves is the confusing one: this refusal reaches git as a
 * non-zero exit, git marks the path conflicted, and `%A` is left holding whatever git had already staged there
 * before the driver ran — *without conflict markers*. A file that looks clean in a conflicted path is the
 * thing an operator stages without reading, which turns a refusal that protected an edit into the loss it was
 * protecting against. Saying only "left untouched" describes the state and names no action, which is half a
 * refusal.
 *
 * `%A` is not the user's edit here, and an earlier version of this message got that backwards. Coral's only
 * automated path into this driver is `git rebase` (`ensureKbMergeDrivers` in `git-sync.ts` sets
 * `rebase.backend merge` and runs `git rebase origin/<branch>`), and git's `--ours`/`--theirs` swap meaning
 * under rebase: `%A`/`--ours` is the upstream commit being rebased onto, `%B`/`--theirs` is the user's own
 * commit being replayed. Reproduced against git 2.43 with a driver that refuses mid-rebase: the real
 * working-tree file is left holding the *upstream* content, and `git checkout --ours` — what this message used
 * to prescribe as "keep your version" — reapplies that same upstream content, discarding the edit it claimed
 * to protect. `git rebase --abort` is the one recovery verified correct regardless of which commit in the
 * rebase is conflicting: it restores the pre-rebase state in full, including the edit that produced the
 * conflict, without picking a side.
 *
 * It also names *which* file. This driver runs once per conflicted path — a `git rebase` touching several
 * `.md` files invokes it separately for each — and git does not prefix a merge driver's stderr with the path
 * it ran on. Without `label` (git's `%P`), a refusal mid-multi-file-conflict gives no way to tell which of
 * several unresolved files it is about, even though the recovery it prescribes (`git rebase --abort`) undoes
 * the whole rebase rather than targeting one file.
 */
export class FrontmatterMergeUnavailableError extends Error {
  constructor(label: string, detail: string) {
    super(
      `Coral could not merge ${label}: \`git merge-file\` did not answer (${detail}). Git has left the path conflicted, and the copy of ${label} on disk right now is the incoming rebase content, not the edit that caused this conflict — it carries no conflict markers to review, so do not stage it as-is. Coral's git sync only reaches this driver through \`git rebase\`; run \`git rebase --abort\` to restore ${label} to what you had before it started, then retry once the underlying failure is resolved.`,
    );
    this.name = 'FrontmatterMergeUnavailableError';
  }
}

/**
 * The largest number `git merge-file` will report as a conflict count. Above it the exit status stops being a
 * count at all: git clamps its own count here precisely so the error range stays distinguishable.
 */
const MAX_MERGE_FILE_CONFLICT_COUNT = 127;

/**
 * What a thrown `git merge-file` means — and the cases that are not a merge result at all.
 *
 * `git merge-file` answers by exiting: `0` merged cleanly, and `1`–`127` is that many conflicts, with the
 * merged text — markers and all — left in `%A` for the caller to keep. Outside that range the number is not a
 * count and no merge happened: `129` is a usage error, and `255` is git refusing the inputs, which is what a
 * NUL byte anywhere in the three files produces. Both were measured against git 2.43 rather than reasoned
 * about, and `255` is the one that matters, because git exits it having written *nothing* — no merge, and no
 * conflict markers either.
 *
 * So a numeric status is read as an answer only inside the range where it is a count. Outside it, and when the
 * throw carries no numeric status at all, the result comes back as its own variant rather than as a number a
 * caller might act on. `execFileSync` reports its own timeout with `code: 'ETIMEDOUT'` and `status: null`, and
 * a launch failure the same way with an errno; read as a number, either becomes `1`, which for this command
 * means "one conflict". That matters more here than anywhere else: `oursPath` is git's
 * `%A`, the real working-tree file, and `runFrontmatterMergeDriver` writes it unconditionally. So a probe that
 * never ran wrote the *unmerged* body — with no conflict markers — over the user's file while telling git the
 * merge conflicted, and the next `git add` or conflict-resolution pass made the loss permanent. Nothing
 * observed the merge; something finalized it.
 *
 * A KB note holding a NUL byte reaches that same end through a different door, on an install with no timeout
 * and nothing wedged, which is why the range check and the timeout belong together: `129` and `255` are the
 * two numeric statuses most likely to be seen, and neither is a conflict count.
 *
 * The bound that makes the timeout reachable on a healthy install is deliberate and stays (an unbounded
 * synchronous subprocess cannot be interrupted). What changes is that a non-answer now refuses instead of
 * guessing.
 *
 * `classifyMergeFileFailure` composes `classifyThrownExecOutcome` (`infra/port-types.ts`) rather than
 * re-deriving "read a thrown subprocess error" locally — that classifier already draws the launch-refused /
 * no-answer / answered split for exactly this thrown shape. It still returns this narrower type instead of
 * `ExecOutcome` directly, because
 * `classifyThrownExecOutcome`'s `answered` means only "a numeric status was thrown": full delegation would
 * read `129` (a usage error) and `255` (git refusing the inputs) as 129 and 255 conflicts. So only its
 * `answered` case gets refined further, against the command-specific 1..127 range below — `launch-refused` and
 * `no-answer` both fold into this type's own `no-answer`, because neither is a merge result the caller can act
 * on.
 */
type MergeFileOutcome =
  | Readonly<{ kind: 'answered'; status: number }>
  | Readonly<{ kind: 'no-answer'; detail: string }>;

function classifyMergeFileFailure(error: unknown): MergeFileOutcome {
  const outcome = classifyThrownExecOutcome(error);
  if (outcome.kind === 'launch-refused') {
    return { kind: 'no-answer', detail: outcome.code };
  }
  if (outcome.kind === 'no-answer') {
    return outcome;
  }
  return outcome.status > 0 && outcome.status <= MAX_MERGE_FILE_CONFLICT_COUNT
    ? outcome
    : { kind: 'no-answer', detail: `git merge-file exited ${outcome.status}` };
}

function mergeFrontmatter(ours: MarkdownDocument, theirs: MarkdownDocument, mergedBody: string, path: string): string {
  const context: BodyMergeContext = {
    oursBody: ours.body,
    theirsBody: theirs.body,
    mergedBody,
    // Advisory when the body carries conflict markers: this hashes the marker text too.
    mergedBodyInputFingerprint: computeBodySurfaceHash(extractBody(mergedBody)),
  };

  switch (classifyMarkdownPath(path)) {
    case 'note':
      return mergeNoteFrontmatter(ours.raw, theirs.raw, context);
    case 'source':
      return mergeSourceFrontmatter(ours.raw, theirs.raw, context);
    case 'community':
      return mergeCommunityFrontmatter(ours.raw, theirs.raw, context);
    case 'wiki':
      return mergeWikiFrontmatter(ours.raw, theirs.raw);
    case 'unknown':
      return chooseUnknownFrontmatter(ours, theirs, context);
  }
}

function mergeNoteFrontmatter(oursRaw: string, theirsRaw: string, context: BodyMergeContext): string {
  const ours = parseFrontmatter(oursRaw);
  const theirs = parseFrontmatter(theirsRaw);
  const inputFingerprint = chooseFingerprintScalar(ours.inputFingerprint, theirs.inputFingerprint, context, true);
  const entrySeq = chooseNumberScalar(ours.entrySeq, theirs.entrySeq);
  const related = unionSorted(ours.related ?? [], theirs.related ?? []);
  const merged: KbNoteFrontmatter = {
    tags: unionSorted(ours.tags, theirs.tags),
    principles: unionSorted(ours.principles, theirs.principles),
    source: chooseStringListScalar(ours.source, theirs.source, context),
    createdAt: chooseLexicographicSmallest(ours.createdAt, theirs.createdAt) as string,
    updatedAt: chooseLexicographicGreatest(ours.updatedAt, theirs.updatedAt) as string,
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    ...(entrySeq === undefined ? {} : { entrySeq }),
    ...(related.length === 0 ? {} : { related }),
  };

  return serializeFrontmatter(merged);
}

function mergeSourceFrontmatter(oursRaw: string, theirsRaw: string, context: BodyMergeContext): string {
  const ours = parseSourceFrontmatter(oursRaw);
  const theirs = parseSourceFrontmatter(theirsRaw);
  const inputFingerprint = chooseFingerprintScalar(ours.inputFingerprint, theirs.inputFingerprint, context, true);
  const entrySeq = chooseNumberScalar(ours.entrySeq, theirs.entrySeq);
  const related = unionSorted(ours.related ?? [], theirs.related ?? []);
  const url = chooseTextScalar(ours.url, theirs.url, context);
  const merged: KbSourceFrontmatter = {
    title: chooseTextScalar(ours.title, theirs.title, context) as string,
    type: chooseTextScalar(ours.type, theirs.type, context) as string,
    tags: unionSorted(ours.tags, theirs.tags),
    ...(url === undefined ? {} : { url }),
    importedAt: chooseLexicographicSmallest(ours.importedAt, theirs.importedAt) as string,
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    ...(entrySeq === undefined ? {} : { entrySeq }),
    ...(related.length === 0 ? {} : { related }),
  };

  return serializeSourceFrontmatter(merged);
}

function mergeCommunityFrontmatter(oursRaw: string, theirsRaw: string, context: BodyMergeContext): string {
  const ours = parseCommunityFrontmatter(oursRaw);
  const theirs = parseCommunityFrontmatter(theirsRaw);
  const summaryInputFingerprint = chooseFingerprintScalar(
    ours.summaryInputFingerprint,
    theirs.summaryInputFingerprint,
    context,
    false,
  );
  const parent = chooseTextScalar(ours.parent, theirs.parent, context);
  const children = chooseStringListScalar(ours.children ?? [], theirs.children ?? [], context);

  return serializeCommunityFrontmatter({
    createdAt: chooseLexicographicSmallest(ours.createdAt, theirs.createdAt) as string,
    updatedAt: chooseLexicographicGreatest(ours.updatedAt, theirs.updatedAt) as string,
    level: chooseNumberScalar(ours.level, theirs.level) ?? 0,
    ...(summaryInputFingerprint === undefined ? {} : { summaryInputFingerprint }),
    ...(parent === undefined ? {} : { parent }),
    ...(children.length === 0 ? {} : { children }),
  });
}

function mergeWikiFrontmatter(oursRaw: string, theirsRaw: string): string {
  const ours = parseWikiFrontmatter(oursRaw);
  const theirs = parseWikiFrontmatter(theirsRaw);

  return serializeWikiFrontmatter({
    tags: unionSorted(ours.tags, theirs.tags),
    createdAt: chooseLexicographicSmallest(ours.createdAt, theirs.createdAt) as string,
    updatedAt: chooseLexicographicGreatest(ours.updatedAt, theirs.updatedAt) as string,
  });
}

function chooseUnknownFrontmatter(ours: MarkdownDocument, theirs: MarkdownDocument, context: BodyMergeContext): string {
  if (ours.frontmatterBlock === theirs.frontmatterBlock) {
    return ours.frontmatterBlock;
  }
  const matchingSide = sideMatchingMergedBody(context);
  if (matchingSide === 'ours') {
    return ours.frontmatterBlock;
  }
  if (matchingSide === 'theirs') {
    return theirs.frontmatterBlock;
  }
  return chooseLexicographicGreatest(ours.frontmatterBlock, theirs.frontmatterBlock) ?? '';
}

function classifyMarkdownPath(path: string): MarkdownKind {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('notes/')) {
    return 'note';
  }
  if (normalized.startsWith('sources/')) {
    return 'source';
  }
  if (normalized.startsWith('communities/')) {
    return 'community';
  }
  if (normalized.startsWith('wiki/')) {
    return 'wiki';
  }
  return 'unknown';
}

function unionSorted(left: readonly string[], right: readonly string[]): string[] {
  return uniqueTrimmedList([...left, ...right]).sort(compareLocale);
}

function chooseStringListScalar(
  ours: readonly string[],
  theirs: readonly string[],
  context: BodyMergeContext,
): string[] {
  const normalizedOurs = unionSorted(ours, []);
  const normalizedTheirs = unionSorted(theirs, []);
  if (sameStringList(normalizedOurs, normalizedTheirs)) {
    return normalizedOurs;
  }

  const matchingSide = sideMatchingMergedBody(context);
  if (matchingSide === 'ours') {
    return normalizedOurs;
  }
  if (matchingSide === 'theirs') {
    return normalizedTheirs;
  }

  return compareStringLists(normalizedOurs, normalizedTheirs) >= 0 ? normalizedOurs : normalizedTheirs;
}

function chooseTextScalar(
  ours: string | undefined,
  theirs: string | undefined,
  context: BodyMergeContext,
): string | undefined {
  if (ours === theirs) {
    return ours;
  }
  const matchingSide = sideMatchingMergedBody(context);
  if (matchingSide === 'ours' && ours !== undefined) {
    return ours;
  }
  if (matchingSide === 'theirs' && theirs !== undefined) {
    return theirs;
  }
  return chooseLexicographicGreatest(ours, theirs);
}

function chooseFingerprintScalar(
  ours: string | undefined,
  theirs: string | undefined,
  context: BodyMergeContext,
  canMatchBodyHash: boolean,
): string | undefined {
  if (ours === theirs) {
    return ours;
  }
  if (canMatchBodyHash) {
    if (ours === context.mergedBodyInputFingerprint && theirs !== context.mergedBodyInputFingerprint) {
      return ours;
    }
    if (theirs === context.mergedBodyInputFingerprint && ours !== context.mergedBodyInputFingerprint) {
      return theirs;
    }
  }

  return chooseTextScalar(ours, theirs, context);
}

function chooseNumberScalar(ours: number | undefined, theirs: number | undefined): number | undefined {
  if (ours === undefined) {
    return theirs;
  }
  if (theirs === undefined) {
    return ours;
  }
  return Math.max(ours, theirs);
}

function chooseLexicographicGreatest(ours: string | undefined, theirs: string | undefined): string | undefined {
  if (ours === undefined) {
    return theirs;
  }
  if (theirs === undefined) {
    return ours;
  }
  return compareLocale(ours, theirs) >= 0 ? ours : theirs;
}

function chooseLexicographicSmallest(ours: string | undefined, theirs: string | undefined): string | undefined {
  if (ours === undefined) {
    return theirs;
  }
  if (theirs === undefined) {
    return ours;
  }
  return compareLocale(ours, theirs) <= 0 ? ours : theirs;
}

function sideMatchingMergedBody(context: BodyMergeContext): 'ours' | 'theirs' | null {
  const normalizedMerged = normalizeContentBody(context.mergedBody);
  const oursMatches =
    context.oursBody === context.mergedBody || normalizeContentBody(context.oursBody) === normalizedMerged;
  const theirsMatches =
    context.theirsBody === context.mergedBody || normalizeContentBody(context.theirsBody) === normalizedMerged;

  if (oursMatches === theirsMatches) {
    return null;
  }
  return oursMatches ? 'ours' : 'theirs';
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareStringLists(left: readonly string[], right: readonly string[]): number {
  return compareLocale(left.join('\u0000'), right.join('\u0000'));
}
