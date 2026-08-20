import { isAbsolute, join } from 'node:path';
import { backendLog } from '../../infra/backend-log.js';
import type { TimerHandle } from '../../infra/port-types.js';
import { INDECISIVE_PROBE_REPROBE_INTERVAL_MS } from '../../infra/process-constants.js';
import { nowIsoString } from '../../infra/time.js';
import type { KbRuntime } from '../contract.js';
import { communityEntryId, noteEntryId, sourceEntryId, wikiEntryId, type KbEntryId } from '../entry-types.js';
import { classifyExecOutcome } from '../../infra/port-types.js';
import type { GitSyncRuntimePicks } from './pipeline-types.js';
import type { CurateAssistantPort } from './assistant.js';
import { curateDb } from './db-access.js';
import { upsertCurateConflictQuarantine, type ConflictQuarantineKind } from './conflict-quarantine.js';
import { runCurateAssistant } from './operations.js';

declare const __PLUGIN_ROOT__: string;

const GITIGNORE_ENTRIES = ['data/', '.obsidian/'];
const GITIGNORE_HEADER = '# Coral KB runtime (device-local, auto-managed)';
const GITATTRIBUTES_ENTRIES = ['.entity-graph.json merge=coral-entity-graph', '*.md merge=coral-frontmatter'];
const GITATTRIBUTES_HEADER = '# Coral KB merge drivers (auto-managed)';
const DEFERRED_COMMIT_DELAY_MS = 60_000;
const GIT_INDEX_LOCK_STALE_MS = 10 * 60 * 1000;
const RECOVERY_REF_NAMESPACE = 'refs/coral-recovery';
const RECOVERY_REF_KEEP_PER_BRANCH = 20;
const GIT_OPERATION_PATHS = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'sequencer',
];
const KB_GIT_DIFF_PATHS = [
  'notes/',
  'sources/',
  'principles/',
  'communities/',
  'wiki/',
  '.entity-graph.json',
  '.gitattributes',
];

export type GitConflictState = {
  hasMarkers: boolean;
  paths: string[];
  markerPaths: string[];
  unmergedPaths: string[];
  /**
   * The subset of `unmergedPaths` where the index carries both stage 2 ("ours") and stage 3 ("theirs")
   * content. That pair is what a content-level 3-way merge — the default text merge, or a configured merge
   * driver — requires to run at all; a delete/modify conflict is missing one of the two by construction (the
   * side that deleted has no blob to stage), so it can never appear here even though it is unmerged.
   */
  contentConflictPaths: string[];
};

export type GitSyncPathChange =
  | {
      status: 'added' | 'modified' | 'deleted';
      path: string;
    }
  | {
      status: 'renamed';
      previousPath: string;
      path: string;
    };

export type GitSyncResult =
  | { kind: 'no-change' }
  | { kind: 'paths'; changes: GitSyncPathChange[] }
  | { kind: 'ambiguous' };

/**
 * The third answer a repo/remote probe inside `createGitSyncController` can give: not yes, not no, but unable
 * to tell. `isGitRepo`/`isGitSyncEnabled` below collapse this into `false` for their boolean call sites — a KB
 * that is not a git repository and a KB this probe could not ask look identical to those callers, and always
 * have. `gitSync` is the one caller that must not collapse it: returning `{ kind: 'no-change' }` for a cycle
 * that could not ask git anything tells the Corpus authority git answered when it did not.
 */
type GitProbeAnswer = 'yes' | 'no' | 'unanswered';

export type GitSyncController = {
  ensureKbGitignore(): void;
  ensureKbMergeDrivers(): void;
  gitSync(signal?: AbortSignal): Promise<GitSyncResult>;
  gitPush(): Promise<void>;
  gitAutoCommit(message: string): void;
  gitAutoCommitAsync(message: string): Promise<void>;
  scheduleDeferredCommit(): void;
  cancelDeferredCommit(): void;
};

type GitProcessPort = GitSyncRuntimePicks['processPort'];

function gitRaw(processPort: GitProcessPort, root: string, args: string[], timeoutMs = 5000) {
  return processPort.execSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    timeout: timeoutMs,
    inheritEnv: true,
  });
}

/**
 * `git ls-files -u <path>` prints one line per (stage, path) pair — `<mode> <object> <stage>\t<path>` — with
 * stage 1/2/3 meaning base/ours/theirs. Reading the stage column, not just the path, is what lets a caller
 * tell a content conflict (stage 2 and 3 both present) apart from a delete/modify one (exactly one of the two,
 * since the side that deleted has no blob to stage) from this single command's output.
 */
function parseUnmergedIndex(raw: string): { paths: string[]; contentConflictPaths: string[] } {
  const stagesByPath = new Map<string, Set<number>>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) {
      continue;
    }
    const path = line.slice(tabIndex + 1).trim();
    if (path.length === 0) {
      continue;
    }
    const stage = Number.parseInt(line.slice(0, tabIndex).trim().split(/\s+/u)[2] ?? '', 10);
    const stages = stagesByPath.get(path) ?? new Set<number>();
    if (Number.isFinite(stage)) {
      stages.add(stage);
    }
    stagesByPath.set(path, stages);
  }

  const paths = [...stagesByPath.keys()].sort();
  const contentConflictPaths = paths.filter((path) => {
    const stages = stagesByPath.get(path);
    return stages !== undefined && stages.has(2) && stages.has(3);
  });
  return { paths, contentConflictPaths };
}

function parseDiffCheckMarkerPaths(raw: string): string[] {
  const paths = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.includes('leftover conflict marker')) {
      continue;
    }
    const lineColumnSeparator = line.match(/:\d+:/u);
    if (lineColumnSeparator === null || lineColumnSeparator.index === undefined) {
      continue;
    }
    const path = line.slice(0, lineColumnSeparator.index);
    if (path.length > 0) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

export function detectGitConflictState({
  root,
  processPort,
  paths = KB_GIT_DIFF_PATHS,
}: {
  root: string;
  processPort: GitProcessPort;
  paths?: readonly string[];
}): GitConflictState {
  const unmergedResult = gitRaw(processPort, root, ['ls-files', '-u', '--', ...paths], 5000);
  if (unmergedResult.error !== undefined || unmergedResult.status === null || unmergedResult.status > 1) {
    // `hasUnmergedIndex()` below takes the same non-answer from the same command and assumes the worst
    // (unmerged). Reading it here as "nothing is unmerged" would give a caller of this function a conflict
    // state that claims to have found no unmerged paths from a question git never actually answered. Throwing
    // puts every caller of this function through the same catch `hasConflictMarkers()` and
    // `detectConflictStateOrFallback()` already give a state they cannot read, so both land on the same
    // assume-the-worst side `hasUnmergedIndex()` takes.
    throw (
      unmergedResult.error ?? new Error(`git ls-files -u could not be answered (exit ${String(unmergedResult.status)})`)
    );
  }
  const { paths: unmergedPaths, contentConflictPaths } = parseUnmergedIndex(
    `${unmergedResult.stdout}\n${unmergedResult.stderr}`,
  );

  const diffCheckResult = gitRaw(processPort, root, ['diff', '--check', 'HEAD', '--', ...paths], 5000);
  const diffCheckOutput = `${diffCheckResult.stdout}\n${diffCheckResult.stderr}`;
  const markerPaths = parseDiffCheckMarkerPaths(diffCheckOutput);
  const pathSet = new Set<string>([...unmergedPaths, ...markerPaths]);

  return {
    hasMarkers: pathSet.size > 0,
    paths: [...pathSet].sort(),
    markerPaths,
    unmergedPaths,
    contentConflictPaths,
  };
}

export function createGitSyncController({
  kb,
  curateAssistant,
  processPort,
  storagePort,
  envPort,
}: {
  kb: KbRuntime;
  curateAssistant: CurateAssistantPort;
} & GitSyncRuntimePicks): GitSyncController {
  // Only a decisive answer. A probe that could not be answered lives in the timestamp below.
  let cachedIsGitRepo: boolean | null = null;
  let lastUnansweredGitRepoProbeAt: number | null = null;
  let deferredCommitTimer: TimerHandle | null = null;
  const root = kb.markdownRoot;

  function git(args: string[], timeoutMs = 15000): string {
    const result = processPort.execSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      timeout: timeoutMs,
      inheritEnv: true,
    });
    // Runtime execSync reports non-zero exits in-band, so rethrow here to preserve existing try/catch semantics.
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
  }

  async function gitAsync(args: string[], timeoutMs = 15000): Promise<string> {
    const result = await processPort.exec('git', args, {
      cwd: root,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      inheritEnv: true,
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
  }

  function gitCommit(message: string): void {
    // Stamp the daemon build version so KB git history records which build
    // produced each commit.
    const stamped = `${message}\n\nCoral-Version: ${kb.version}`;
    try {
      git(['commit', '-m', stamped], 10000);
    } catch {
      git(['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-m', stamped], 10000);
    }
  }

  /**
   * Every git-sync operation gates on this, so a wrong `false` is not a degraded mode — it is the KB silently
   * ceasing to be version-controlled, with no commit, no push, and nothing said. That is what caching every
   * failure produced: one `EAGAIN` under fork pressure, or one 5s timeout on a busy disk, and the answer was
   * `false` for the lifetime of the daemon.
   *
   * So only an answer is cached. A non-answer is remembered with an expiry instead — long enough that a wedged
   * environment is not re-probed on each of the call sites, short enough that a recovered one heals
   * without a restart. Within the window the operations are skipped, which is the same conservative direction
   * as before; the difference is that it ends.
   */
  function probeIsGitRepo(): GitProbeAnswer {
    if (cachedIsGitRepo !== null) {
      return cachedIsGitRepo ? 'yes' : 'no';
    }
    if (
      lastUnansweredGitRepoProbeAt !== null &&
      kb.time.now() - lastUnansweredGitRepoProbeAt < INDECISIVE_PROBE_REPROBE_INTERVAL_MS
    ) {
      return 'unanswered';
    }

    // Classified from the raw result rather than from a caught error. `git()` rethrows, and by the time an
    // exception reaches a `catch` here it has lost which of the two it is: a non-zero exit `git()` synthesised
    // (an answer) or an error `real.ts` passed through (not one).
    const outcome = classifyExecOutcome(gitRaw(processPort, root, ['rev-parse', '--is-inside-work-tree'], 5000));

    // `launch-refused` folds in here rather than being read as "answered, and non-zero, so no": it means git
    // itself could not be launched (measured: EPERM under a sandbox that denies `execve`, or ENOTDIR/EACCES on
    // a root that is momentarily not traversable — autofs, NFS, an encrypted home not yet unlocked). That is a
    // standing fact about *launching git in this environment*, which `infra/process-constants.ts` documents as
    // cacheable — but it answers nothing about whether `root` is a git work tree, the question this probe
    // asks. Caching the derived "no" from it is what let one EPERM/ENOTDIR turn off KB git sync for the
    // daemon's lifetime with no commit, no push, and no warning. `probeIsGitSyncEnabled` below already folds
    // `launch-refused` into `'unanswered'` for the same reason; this keeps the two in agreement.
    if (outcome.kind === 'no-answer' || outcome.kind === 'launch-refused') {
      // Once per interval rather than once per call, and said at all because the consequence — a KB that
      // stops committing — is otherwise indistinguishable from a KB that was never a repository.
      const detail = outcome.kind === 'no-answer' ? outcome.detail : outcome.code;
      backendLog.warn(
        `[KB] git sync could not determine whether ${root} is a git work tree (${detail}); skipping git operations for now.`,
      );
      lastUnansweredGitRepoProbeAt = kb.time.now();
      return 'unanswered';
    }

    lastUnansweredGitRepoProbeAt = null;
    cachedIsGitRepo = outcome.status === 0;
    return cachedIsGitRepo ? 'yes' : 'no';
  }

  /**
   * This is `probeIsGitRepo` collapsed to the boolean its other call sites need — `'no'` and `'unanswered'`
   * are the same "skip this operation" to them.
   */
  function isGitRepo(): boolean {
    return probeIsGitRepo() === 'yes';
  }

  /**
   * The blanket catch here is deliberate, and the difference from `isGitRepo` above is that nothing is
   * remembered. A `git remote` that could not be answered skips this one cycle of `gitSync`/`gitPush`, and the
   * scheduler asks again on the next; the same failure in `isGitRepo` was cached and skipped every cycle
   * until the daemon restarted. Splitting the disposition here would buy a re-probe that the next call already
   * makes.
   */
  function probeIsGitSyncEnabled(): GitProbeAnswer {
    if (envPort.get('CORAL_KB_GIT_SYNC') !== '1') {
      return 'no';
    }
    const result = gitRaw(processPort, root, ['remote'], 5000);
    const outcome = classifyExecOutcome(result);
    if (outcome.kind === 'no-answer' || outcome.kind === 'launch-refused') {
      // Said out loud because the operator asked for this: with `CORAL_KB_GIT_SYNC=1`, a cycle that skips
      // sync is a cycle that did not do the thing they enabled, and it is otherwise indistinguishable from a
      // repository with no remote configured. Nothing is remembered — the scheduler asks again next cycle,
      // which is why this needs no interval where `isGitRepo` does. `launch-refused` (git itself could not be
      // launched) folds in here rather than returning `'no'` silently: it says exactly as little about whether
      // a remote exists as a timeout does.
      const detail = outcome.kind === 'no-answer' ? outcome.detail : outcome.code;
      backendLog.warn(`[KB] git sync could not list remotes for ${root} (${detail}); skipping this cycle.`);
      return 'unanswered';
    }
    if (outcome.status !== 0) {
      // Measured against real git: `git remote` reports "no remotes configured" by exiting 0 with empty
      // stdout, and every failure — outside a repository, a corrupted `.git`, anything fatal — exits 128 with
      // nothing on stdout. There is no outcome where a non-zero exit means "no remote"; it means git refused
      // to answer the question, same as a timeout, so it must not be read as the settled "no" below.
      //
      // Nothing is cached here, by the same reasoning as the branch above, so a repository that starts
      // answering `git remote` cleanly again ends this on its very next scheduled `gitSync`/`gitPush` call —
      // the exit is "the next cycle's own probe", not a separate latch to clear. A repository whose `.git`
      // stays broken for good has no other exit than that fix, and repeats this warn every cycle until then.
      backendLog.warn(
        `[KB] git sync could not list remotes for ${root} (git remote exited ${outcome.status}); skipping this cycle.`,
      );
      return 'unanswered';
    }
    return result.stdout.trim().length > 0 ? 'yes' : 'no';
  }

  function isGitSyncEnabled(): boolean {
    return probeIsGitSyncEnabled() === 'yes';
  }

  function getDefaultBranch(): string {
    try {
      const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], 5000).trim();
      return ref.replace(/^origin\//, '') || 'main';
    } catch {
      return 'main';
    }
  }

  function hasStagedChanges(): boolean {
    try {
      git(['diff', '--cached', '--quiet'], 5000);
      return false;
    } catch {
      return true;
    }
  }

  function hasConflictMarkers(): boolean {
    try {
      return detectGitConflictState({ root, processPort }).hasMarkers;
    } catch {
      return true;
    }
  }

  function gitPath(path: string): string {
    try {
      const resolved = git(['rev-parse', '--git-path', path], 5000).trim();
      if (resolved.length > 0) {
        return isAbsolute(resolved) ? resolved : join(root, resolved);
      }
    } catch {
      // Fall back to the common worktree layout below.
    }
    return join(root, '.git', path);
  }

  function isRebaseInProgress(): boolean {
    try {
      return storagePort.existsSync(gitPath('rebase-merge')) || storagePort.existsSync(gitPath('rebase-apply'));
    } catch {
      return true;
    }
  }

  function isGitOperationInProgress(): boolean {
    try {
      return GIT_OPERATION_PATHS.some((path) => storagePort.existsSync(gitPath(path)));
    } catch {
      return true;
    }
  }

  function cleanupStaleGitIndexLock(): void {
    try {
      if (!isGitRepo()) {
        return;
      }
      const indexLockPath = gitPath('index.lock');
      if (!storagePort.existsSync(indexLockPath)) {
        return;
      }
      if (kb.time.now() - storagePort.statSync(indexLockPath).mtimeMs < GIT_INDEX_LOCK_STALE_MS) {
        return;
      }
      if (isGitOperationInProgress()) {
        return;
      }
      storagePort.rmSync(indexLockPath, { force: true });
    } catch {
      // Best-effort boot cleanup; git's own operation-state markers stay authoritative.
    }
  }

  function hasUnmergedIndex(): boolean {
    try {
      return git(['ls-files', '-u'], 5000).trim().length > 0;
    } catch {
      return true;
    }
  }

  function isSafeForAutoCommit(): boolean {
    return !isGitOperationInProgress() && !hasUnmergedIndex() && !hasConflictMarkers();
  }

  function kbGitPaths(): string[] {
    const paths: string[] = [];
    for (const entry of [
      'notes/',
      'sources/',
      'principles/',
      'communities/',
      'wiki/',
      '.entity-graph.json',
      '.gitignore',
      '.gitattributes',
    ]) {
      if (storagePort.existsSync(join(root, entry.replace(/\/$/, '')))) {
        paths.push(entry);
      }
    }
    return paths;
  }

  function readHead(): string | null {
    try {
      return git(['rev-parse', 'HEAD'], 5000).trim();
    } catch {
      return null;
    }
  }

  function parseNameStatusDiff(raw: string): GitSyncPathChange[] | null {
    const changes: GitSyncPathChange[] = [];

    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (line === '') {
        continue;
      }
      const columns = line.split('\t');
      const status = columns[0] ?? '';
      if (status === 'A') {
        const path = columns[1];
        if (path === undefined) {
          return null;
        }
        changes.push({ status: 'added', path });
        continue;
      }
      if (status === 'M') {
        const path = columns[1];
        if (path === undefined) {
          return null;
        }
        changes.push({ status: 'modified', path });
        continue;
      }
      if (status === 'D') {
        const path = columns[1];
        if (path === undefined) {
          return null;
        }
        changes.push({ status: 'deleted', path });
        continue;
      }
      if (status.startsWith('R')) {
        const previousPath = columns[1];
        const path = columns[2];
        if (previousPath === undefined || path === undefined) {
          return null;
        }
        changes.push({ status: 'renamed', previousPath, path });
        continue;
      }
      if (status.startsWith('C')) {
        const path = columns[2] ?? columns[1];
        if (path === undefined) {
          return null;
        }
        changes.push({ status: 'added', path });
        continue;
      }

      return null;
    }

    return changes;
  }

  function diffKbPathsBetweenRevisions(previousHead: string, nextHead: string): GitSyncResult {
    try {
      const raw = git(
        ['diff', '--name-status', '--find-renames', `${previousHead}..${nextHead}`, '--', ...KB_GIT_DIFF_PATHS],
        10000,
      );
      const changes = parseNameStatusDiff(raw);
      if (changes === null) {
        return { kind: 'ambiguous' };
      }
      if (changes.length === 0) {
        return { kind: 'no-change' };
      }
      return {
        kind: 'paths',
        changes,
      };
    } catch {
      return { kind: 'ambiguous' };
    }
  }

  function appendMissingManagedLines(path: string, header: string, entries: readonly string[]): void {
    let existing = '';
    try {
      existing = storagePort.readFileSync(path, 'utf-8');
    } catch {
      /* no file */
    }

    const lines = existing.split('\n');
    const missing: string[] = [];
    for (const entry of entries) {
      let present = false;
      for (const line of lines) {
        if (line.trim() === entry) {
          present = true;
          break;
        }
      }
      if (!present) {
        missing.push(entry);
      }
    }
    if (missing.length === 0) {
      return;
    }

    const suffix = `${header}\n${missing.join('\n')}\n`;
    const newContent = existing.length === 0 ? suffix : `${existing.replace(/\n*$/, '\n\n')}${suffix}`;
    storagePort.writeAtomicSync(path, newContent);
  }

  function ensureKbGitignore(): void {
    const gitignorePath = join(root, '.gitignore');
    try {
      appendMissingManagedLines(gitignorePath, GITIGNORE_HEADER, GITIGNORE_ENTRIES);
    } catch {
      // best-effort
    }
  }

  /**
   * `.gitattributes` names the merge drivers by name; the `git config` calls below are what make those names
   * resolve to anything. Writing the attributes file first would let `.gitattributes` claim a driver before
   * `git config` had ever registered it: if `isGitRepo()` was momentarily false, or any one
   * `git config` call threw (both best-effort, both plausible under fork pressure), the attributes stayed
   * written while the drivers stayed unconfigured for the rest of this process's life, since this function
   * runs once at daemon start and — for an installation that never sets `CORAL_KB_GIT_SYNC=1` — never again.
   * With `merge=coral-entity-graph`/`coral-frontmatter` named but not configured, git falls back to its
   * built-in text merge for every later conflict, writing raw `<<<<<<<` markers straight into
   * `.entity-graph.json`.
   *
   * So the attributes file is now the last write in this function, inside the same try as the config calls:
   * `.gitattributes` only ever names a driver once every `git config` call that backs it has already
   * succeeded this attempt. `appendMissingManagedLines` is idempotent, so a later successful attempt still
   * catches up a repo that was not one yet.
   */
  function ensureKbMergeDrivers(): void {
    try {
      if (!isGitRepo()) {
        return;
      }
      git(['config', 'merge.coral-entity-graph.name', 'Coral entity graph CRDT merge driver'], 5000);
      git(['config', 'merge.coral-entity-graph.driver', buildEntityGraphMergeDriverCommand()], 5000);
      git(['config', 'merge.coral-frontmatter.name', 'Coral markdown frontmatter/body merge driver'], 5000);
      git(['config', 'merge.coral-frontmatter.driver', buildFrontmatterMergeDriverCommand()], 5000);
      git(['config', 'rebase.backend', 'merge'], 5000);
      appendMissingManagedLines(join(root, '.gitattributes'), GITATTRIBUTES_HEADER, GITATTRIBUTES_ENTRIES);
    } catch {
      // best-effort
    }
  }

  function buildEntityGraphMergeDriverCommand(): string {
    return buildMergeDriverCommand('merge-entity-graph', '"%O" "%A" "%B"');
  }

  function buildFrontmatterMergeDriverCommand(): string {
    return buildMergeDriverCommand('merge-frontmatter', '"%O" "%A" "%B" "%P"');
  }

  function buildMergeDriverCommand(subcommand: string, gitArgs: string): string {
    const pluginRoot = resolvePluginRoot();
    const cliPath = pluginRoot === undefined ? 'coral-cli' : join(pluginRoot, 'bridge', 'coral-cli.cjs');
    if (pluginRoot === undefined) {
      return `coral-cli kb ${subcommand} ${gitArgs}`;
    }
    return `${shellQuote(process.execPath)} ${shellQuote(cliPath)} kb ${subcommand} ${gitArgs}`;
  }

  function resolvePluginRoot(): string | undefined {
    if (typeof __PLUGIN_ROOT__ === 'string' && __PLUGIN_ROOT__.length > 0) {
      return __PLUGIN_ROOT__;
    }
    return envPort.get('CLAUDE_PLUGIN_ROOT');
  }

  function shellQuote(value: string): string {
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  }

  function detectConflictState(): GitConflictState {
    return detectGitConflictState({ root, processPort });
  }

  /**
   * Narrowed to `contentConflictPaths` rather than every unmerged path: a delete/modify conflict is unmerged
   * with no markers too, but for a reason this function must not act on the same way — unlike a driver-refused
   * content conflict, it is not a dead end for `resolveConflictsWithClaude` below, which is the path it reaches
   * instead of the recovery diversion this function feeds. Restricting to paths where both "ours" and "theirs"
   * content exist is what tells the two apart: only that shape is one where a content merge — the default text
   * merge, or a configured driver — was even attempted, so only there does "no markers" mean the merge
   * produced nothing reviewable.
   */
  function markerlessUnmergedPaths(state: GitConflictState): string[] {
    const markerPathSet = new Set(state.markerPaths);
    return state.contentConflictPaths.filter((path) => !markerPathSet.has(path));
  }

  function sanitizeRefComponent(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^\.+|\.+$/gu, '');
    if (sanitized === '' || sanitized.endsWith('.lock')) {
      return 'branch';
    }
    return sanitized;
  }

  function recoveryBranchRefPath(branch: string): string {
    const parts = branch
      .split('/')
      .map((part) => sanitizeRefComponent(part))
      .filter((part) => part.length > 0);
    return parts.length === 0 ? 'main' : parts.join('/');
  }

  function buildRecoveryRef(branch: string, head: string): string {
    const stamp = nowIsoString(kb.time).replace(/[-:.]/gu, '');
    return `${RECOVERY_REF_NAMESPACE}/${recoveryBranchRefPath(branch)}/${stamp}-${head.slice(0, 12)}`;
  }

  function recoveryRefPrefix(branch: string): string {
    return `${RECOVERY_REF_NAMESPACE}/${recoveryBranchRefPath(branch)}`;
  }

  function pruneRecoveryRefs(branch: string): void {
    const prefix = recoveryRefPrefix(branch);
    const raw = git(['for-each-ref', '--format=%(refname)', prefix], 5000).trim();
    if (raw.length === 0) {
      return;
    }

    const refs = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort()
      .reverse();
    for (const ref of refs.slice(RECOVERY_REF_KEEP_PER_BRANCH)) {
      try {
        git(['update-ref', '-d', ref], 5000);
      } catch {
        // Best-effort retention; never risk recovery to prune an old ref.
      }
    }
  }

  function preserveHeadOnRecoveryRef(branch: string): string | null {
    const head = readHead();
    if (head === null) {
      return null;
    }

    const recoveryRef = buildRecoveryRef(branch, head);
    git(['update-ref', recoveryRef, 'HEAD'], 5000);
    return recoveryRef;
  }

  function entryForConflictPath(
    path: string,
  ): { entryId: KbEntryId; kind: ConflictQuarantineKind; slug: string } | null {
    const normalized = path.replace(/\\/gu, '/');
    const match = /^(notes|sources|communities|wiki)\/(.+)\.md$/u.exec(normalized);
    if (match === null) {
      return null;
    }

    const section = match[1];
    const slug = match[2];
    if (slug === undefined || slug.length === 0) {
      return null;
    }

    try {
      if (section === 'notes') {
        return { entryId: noteEntryId(slug), kind: 'note', slug };
      }
      if (section === 'sources') {
        return { entryId: sourceEntryId(slug), kind: 'source', slug };
      }
      if (section === 'communities') {
        return { entryId: communityEntryId(slug), kind: 'community', slug };
      }
      if (section === 'wiki') {
        return { entryId: wikiEntryId(slug), kind: 'wiki', slug };
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * `entryForConflictPath` only recognizes `notes/`, `sources/`, `communities/`, and `wiki/` `.md` paths.
   * `principles/*.md`, `.gitattributes`, and `.entity-graph.json`
   * are real paths in `KB_GIT_DIFF_PATHS` with no entry kind to key a quarantine row on, so they come back here
   * as `unrecordable` rather than being silently dropped: `recoverRebaseConflict` below reads this list to
   * decide whether it may report full success.
   */
  function quarantineConflictPaths(
    paths: readonly string[],
    recoveryRef: string,
  ): { quarantined: Array<{ entryId: KbEntryId; slug: string; path: string }>; unrecordable: string[] } {
    const detectedAt = nowIsoString(kb.time);
    const quarantined: Array<{ entryId: KbEntryId; slug: string; path: string }> = [];
    const unrecordable: string[] = [];
    const seen = new Set<KbEntryId>();
    for (const path of paths) {
      const entry = entryForConflictPath(path);
      if (entry === null) {
        unrecordable.push(path);
        continue;
      }
      if (seen.has(entry.entryId)) {
        continue;
      }
      seen.add(entry.entryId);
      upsertCurateConflictQuarantine(curateDb(kb), {
        entryId: entry.entryId,
        kind: entry.kind,
        slug: entry.slug,
        path,
        recoveryRef,
        detectedAt,
      });
      quarantined.push({ entryId: entry.entryId, slug: entry.slug, path });
    }
    return { quarantined, unrecordable };
  }

  function logRecoveryOutcome(
    recoveryRef: string,
    branch: string,
    accounting:
      | { kind: 'blind' }
      | { kind: 'accounted'; quarantined: readonly { slug: string }[]; unrecordable: readonly string[] },
  ): void {
    backendLog.warn(
      [
        `[KB] git rebase body conflict recovered on ${branch}; local commits preserved at ${recoveryRef}; worktree reset to origin/${branch}.`,
        accounting.kind === 'blind'
          ? `The conflict state could not be read before recovery, so nothing was inspected or quarantined; check the paths at ${recoveryRef} for KB entries yourself.`
          : undefined,
        accounting.kind === 'accounted' && accounting.quarantined.length > 0
          ? `Quarantined entries: ${accounting.quarantined.map((entry) => entry.slug).join(', ')}.`
          : undefined,
        accounting.kind === 'accounted' && accounting.unrecordable.length > 0
          ? `Not tracked by 'kb diagnose' (no KB entry keys these paths): ${accounting.unrecordable.join(', ')}. Recover them from ${recoveryRef} directly.`
          : undefined,
        `List recovery refs with 'git for-each-ref ${RECOVERY_REF_NAMESPACE}'.`,
        `After landing or discarding recovered work, cleanup with 'git update-ref -d ${recoveryRef}'.`,
        `Coral keeps the newest ${RECOVERY_REF_KEEP_PER_BRANCH} recovery refs per branch automatically.`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' '),
    );
  }

  /**
   * `'recovered'`, `'recovered-unaccounted'`, and `'recovered-blind'` all mean the rebase was aborted and local
   * commits are safe on `recoveryRef` — they differ in what could be said about the conflict itself.
   * `'recovered'` means the state was read and every conflicted path also got a queryable quarantine row;
   * `'recovered-unaccounted'` means the state was read but at least one path has no KB entry to key a row on;
   * `'recovered-blind'` means the state could not be read at all, so nothing was inspected or quarantined.
   */
  type RebaseRecoveryOutcome =
    | { status: 'recovered' }
    | { status: 'recovered-unaccounted' }
    | { status: 'recovered-blind' }
    | { status: 'failed' };

  function recoverRebaseConflict(branch: string, conflictReadout: ConflictStateReadout): RebaseRecoveryOutcome {
    try {
      git(['rebase', '--abort'], 10000);
    } catch (error: unknown) {
      backendLog.error(
        '[KB] git rebase conflict recovery could not abort the rebase; leaving worktree untouched',
        error,
      );
      return { status: 'failed' };
    }

    let recoveryRef: string | null;
    try {
      recoveryRef = preserveHeadOnRecoveryRef(branch);
    } catch (error: unknown) {
      backendLog.error(
        '[KB] git rebase conflict recovery could not preserve local commits; leaving worktree untouched',
        error,
      );
      return { status: 'failed' };
    }
    if (recoveryRef === null) {
      backendLog.error('[KB] git rebase conflict recovery could not read HEAD; leaving worktree untouched');
      return { status: 'failed' };
    }

    let quarantineOutcome: {
      quarantined: Array<{ entryId: KbEntryId; slug: string; path: string }>;
      unrecordable: string[];
    } | null = null;
    if (conflictReadout.kind === 'observed') {
      try {
        quarantineOutcome = quarantineConflictPaths(conflictReadout.state.paths, recoveryRef);
      } catch (error: unknown) {
        backendLog.error(
          `[KB] git rebase conflict recovery preserved local commits at ${recoveryRef} but could not write conflict quarantine; leaving worktree untouched`,
          error,
        );
        return { status: 'failed' };
      }
    }

    try {
      pruneRecoveryRefs(branch);
    } catch {
      // Retention is best-effort; preserving the current recovery ref is the hard requirement.
    }

    try {
      git(['reset', '--hard', `origin/${branch}`], 30000);
    } catch (error: unknown) {
      backendLog.error(
        `[KB] git rebase conflict recovery preserved local commits at ${recoveryRef} but could not reset to origin/${branch}`,
        error,
      );
      return { status: 'failed' };
    }

    if (quarantineOutcome === null) {
      logRecoveryOutcome(recoveryRef, branch, { kind: 'blind' });
      return { status: 'recovered-blind' };
    }

    logRecoveryOutcome(recoveryRef, branch, {
      kind: 'accounted',
      quarantined: quarantineOutcome.quarantined,
      unrecordable: quarantineOutcome.unrecordable,
    });
    return quarantineOutcome.unrecordable.length === 0 ? { status: 'recovered' } : { status: 'recovered-unaccounted' };
  }

  async function resolveConflictsWithClaude(signal?: AbortSignal): Promise<boolean> {
    const prompt = [
      'Git rebase conflict in the Coral KB repository.',
      'The deterministic KB merge drivers have already handled derivative files and markdown frontmatter set fields.',
      'Resolve only the remaining <<<<<<< / ======= / >>>>>>> conflicts in note, source, community, or wiki body content.',
      "Preserve both sides' authored intent where possible; do not silently discard either side's prose.",
      'Do not touch frontmatter.',
      'Stage all resolved files with git add.',
    ].join(' ');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) {
        return false;
      }

      try {
        await runCurateAssistant(curateAssistant, prompt, 'git-conflict-resolution', signal);
      } catch {
        return false;
      }

      if (signal?.aborted) {
        return false;
      }
      if (hasConflictMarkers()) {
        continue;
      }

      try {
        git(['add', '-A'], 5000);
        git(['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'rebase', '--continue'], 30000);
        return true;
      } catch {
        if (isRebaseInProgress() && hasConflictMarkers()) {
          return true;
        }
      }
    }

    return false;
  }

  function abortInProgressRebase(): void {
    try {
      git(['rebase', '--abort'], 10000);
    } catch (error: unknown) {
      backendLog.error('[KB] git rebase cancellation could not abort the in-progress rebase', error);
    }
  }

  /**
   * The disposition `detectConflictState()` collapses into for a caller that must recover regardless of
   * whether it could read the conflict: either the state was actually read (`observed`), or reading it failed
   * and nothing about which paths conflicted is known (`unreadable`). `recoverRebaseConflict` reads this
   * discriminant to decide whether it may quarantine anything at all — an `unreadable` readout has no `state`
   * to quarantine from, rather than a `state` whose `paths` happen to be empty.
   */
  type ConflictStateReadout = { kind: 'observed'; state: GitConflictState } | { kind: 'unreadable' };

  /**
   * `hasConflictMarkers()` above already treats a throw from this same probe as "assume the worst, let
   * recovery decide" rather than propagating it — every call site here needs that same fallback, since an
   * unguarded throw would escape this loop, be swallowed by `gitSync`'s outer catch as "offline or no remote",
   * and leave the rebase in progress for the next cycle's `git add -A` to run against. `kind: 'unreadable'` is
   * honest about what happened: the state genuinely could not be read, so nothing is claimed to have been
   * individually inspected, only that recovery — abort, preserve, reset — still runs.
   */
  function detectConflictStateOrFallback(): ConflictStateReadout {
    try {
      return { kind: 'observed', state: detectConflictState() };
    } catch (error: unknown) {
      backendLog.error('[KB] git rebase conflict recovery could not read the conflict state; recovering blind', error);
      return { kind: 'unreadable' };
    }
  }

  async function continueOrRecoverRebase(
    branch: string,
    signal?: AbortSignal,
  ): Promise<'continued' | 'llm-resolved' | RebaseRecoveryOutcome['status']> {
    let usedLlmConflictResolution = false;

    for (let attempt = 0; attempt < 64; attempt += 1) {
      if (signal?.aborted) {
        abortInProgressRebase();
        return 'failed';
      }

      if (hasConflictMarkers()) {
        const conflictReadout = detectConflictStateOrFallback();
        const unresolvable = conflictReadout.kind === 'observed' ? markerlessUnmergedPaths(conflictReadout.state) : [];
        if (unresolvable.length > 0) {
          backendLog.warn(
            `[KB] git rebase conflict on ${branch} leaves ${unresolvable.join(', ')} unmerged with no conflict markers for the assistant to act on (a merge driver may have refused to answer, or the conflict has no text form); recovering instead of asking it to resolve markers that are not there.`,
          );
          return recoverRebaseConflict(branch, conflictReadout).status;
        }

        if (await resolveConflictsWithClaude(signal)) {
          usedLlmConflictResolution = true;
          if (!isRebaseInProgress() && !hasConflictMarkers()) {
            return 'llm-resolved';
          }
          continue;
        }
        if (signal?.aborted) {
          abortInProgressRebase();
          return 'failed';
        }
        return recoverRebaseConflict(branch, detectConflictStateOrFallback()).status;
      }

      try {
        git(['add', '-A'], 5000);
        git(['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'rebase', '--continue'], 30000);
        if (!isRebaseInProgress() && !hasConflictMarkers()) {
          return usedLlmConflictResolution ? 'llm-resolved' : 'continued';
        }
      } catch {
        // A later commit in the rebase may now be stopped; loop to inspect it.
      }
    }

    const conflictReadout = detectConflictStateOrFallback();
    if (conflictReadout.kind === 'unreadable' || conflictReadout.state.hasMarkers || isRebaseInProgress()) {
      return recoverRebaseConflict(branch, conflictReadout).status;
    }

    return 'failed';
  }

  async function gitSync(signal?: AbortSignal): Promise<GitSyncResult> {
    const repoProbe = probeIsGitRepo();
    if (repoProbe === 'unanswered') {
      return { kind: 'ambiguous' };
    }
    if (repoProbe === 'no') {
      return { kind: 'no-change' };
    }
    const syncEnabledProbe = probeIsGitSyncEnabled();
    if (syncEnabledProbe === 'unanswered') {
      return { kind: 'ambiguous' };
    }
    if (syncEnabledProbe === 'no') {
      return { kind: 'no-change' };
    }

    ensureKbMergeDrivers();
    cancelDeferredCommit();
    const branch = getDefaultBranch();
    const headBeforeSync = readHead();
    let usedConflictRecovery = false;
    let usedLlmConflictResolution = false;
    let rebaseRecoveryFailed = false;

    try {
      await gitAsync(['fetch', 'origin'], 30000);

      try {
        if (git(['status', '--porcelain'], 5000).trim().length > 0 && isSafeForAutoCommit()) {
          git(['add', '-A'], 5000);
          gitCommit('auto: pre-sync snapshot');
        }
      } catch {
        // commit failure — proceed with rebase anyway
      }

      try {
        await gitAsync(['rebase', `origin/${branch}`]);
      } catch {
        const rebaseResult = await continueOrRecoverRebase(branch, signal);
        if (
          rebaseResult === 'recovered' ||
          rebaseResult === 'recovered-unaccounted' ||
          rebaseResult === 'recovered-blind'
        ) {
          usedConflictRecovery = true;
        }
        if (rebaseResult === 'llm-resolved') {
          usedLlmConflictResolution = true;
        }
        if (rebaseResult === 'failed') {
          // A rebase that neither continued nor recovered may still be in progress, mid-replay, at a HEAD that
          // is not the KB's own history — `diffKbPathsBetweenRevisions` below must not be asked to describe
          // what changed between two revisions when one of them is that transient state.
          rebaseRecoveryFailed = true;
        }
      }
    } catch {
      // Offline or no remote; continue with local state.
    }

    return syncDisposition(headBeforeSync, readHead(), {
      usedConflictRecovery,
      usedLlmConflictResolution,
      rebaseRecoveryFailed,
    });
  }

  /**
   * What a completed cycle may claim about which KB paths changed.
   *
   * A diff between two revisions is a positive claim, so it is reachable only from two revisions this cycle
   * actually read and a history nothing rewrote underneath them. Every other combination answers
   * `'ambiguous'`, which asks the consumer to rebuild its surface rather than trust a list.
   *
   * The null check precedes the equality comparison because `null === null` is true, so an equality check
   * placed first swallows the both-unreadable case — the common one, since whatever stopped the first read is
   * still in effect for the second. `readHead()` also answers `null` for a repository with no commits yet;
   * both share one exit, the next cycle whose `git rev-parse HEAD` resolves.
   */
  function syncDisposition(
    headBefore: string | null,
    headAfter: string | null,
    rewrote: { usedConflictRecovery: boolean; usedLlmConflictResolution: boolean; rebaseRecoveryFailed: boolean },
  ): GitSyncResult {
    if (headBefore === null || headAfter === null) return { kind: 'ambiguous' };
    if (headBefore === headAfter) return { kind: 'no-change' };
    if (rewrote.usedConflictRecovery || rewrote.usedLlmConflictResolution || rewrote.rebaseRecoveryFailed) {
      return { kind: 'ambiguous' };
    }
    return diffKbPathsBetweenRevisions(headBefore, headAfter);
  }

  async function gitPush(): Promise<void> {
    if (!isGitRepo() || !isGitSyncEnabled()) {
      return;
    }
    try {
      await gitAsync(['push', 'origin', getDefaultBranch()], 30000);
    } catch {
      /* next cycle */
    }
  }

  function gitAutoCommit(message: string): void {
    if (!isGitRepo()) {
      return;
    }
    try {
      if (!isSafeForAutoCommit()) {
        return;
      }
      const paths = kbGitPaths();
      if (paths.length === 0) {
        return;
      }
      git(['add', ...paths], 10000);
      if (!hasStagedChanges()) {
        return;
      }
      gitCommit(message);
    } catch {
      // best-effort
    }
  }

  async function gitAutoCommitAsync(message: string): Promise<void> {
    if (!isGitRepo()) {
      return;
    }
    try {
      if (!isSafeForAutoCommit()) {
        return;
      }
      const paths = kbGitPaths();
      if (paths.length === 0) {
        return;
      }
      await gitAsync(['add', ...paths], 10000);
      if (!hasStagedChanges()) {
        return;
      }
      gitCommit(message);
    } catch {
      // best-effort
    }
  }

  function scheduleDeferredCommit(): void {
    if (!isGitRepo() || deferredCommitTimer !== null || !isSafeForAutoCommit()) {
      return;
    }
    deferredCommitTimer = kb.time.setTimeout(() => {
      deferredCommitTimer = null;
      void gitAutoCommitAsync('auto: kb mutation');
    }, DEFERRED_COMMIT_DELAY_MS);
    deferredCommitTimer.unref?.();
  }

  function cancelDeferredCommit(): void {
    if (deferredCommitTimer !== null) {
      kb.time.clearTimeout(deferredCommitTimer);
      deferredCommitTimer = null;
    }
  }

  cleanupStaleGitIndexLock();

  return {
    ensureKbGitignore,
    ensureKbMergeDrivers,
    gitSync,
    gitPush,
    gitAutoCommit,
    gitAutoCommitAsync,
    scheduleDeferredCommit,
    cancelDeferredCommit,
  };
}
