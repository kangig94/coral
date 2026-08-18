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

function parseUnmergedPaths(raw: string): string[] {
  const paths = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) {
      continue;
    }
    const path = line.slice(tabIndex + 1).trim();
    if (path.length > 0) {
      paths.add(path);
    }
  }
  return [...paths].sort();
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
  const unmergedOutput = `${unmergedResult.stdout}\n${unmergedResult.stderr}`;
  const unmergedPaths =
    unmergedResult.error !== undefined || unmergedResult.status === null || unmergedResult.status > 1
      ? []
      : parseUnmergedPaths(unmergedOutput);

  const diffCheckResult = gitRaw(processPort, root, ['diff', '--check', 'HEAD', '--', ...paths], 5000);
  const diffCheckOutput = `${diffCheckResult.stdout}\n${diffCheckResult.stderr}`;
  const markerPaths = parseDiffCheckMarkerPaths(diffCheckOutput);
  const pathSet = new Set<string>([...unmergedPaths, ...markerPaths]);

  return {
    hasMarkers: pathSet.size > 0,
    paths: [...pathSet].sort(),
    markerPaths,
    unmergedPaths,
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
    // produced each commit. `kb.version` is threaded from the composed identity.
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
   * environment is not re-probed on each of the seven call sites, short enough that a recovered one heals
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
    // (an answer) or an error `real.ts` passed through (not one). An earlier fix did read the caught error and
    // defaulted an unrecognised shape to "git answered" — the one place on this branch where an unknown shape
    // produced the permanent wrong answer instead of a repeated command.
    const outcome = classifyExecOutcome(gitRaw(processPort, root, ['rev-parse', '--is-inside-work-tree'], 5000));

    if (outcome.kind === 'no-answer') {
      // Once per interval rather than once per call, and said at all because the consequence — a KB that
      // stops committing — is otherwise indistinguishable from a KB that was never a repository.
      backendLog.warn(
        `[KB] git sync could not determine whether ${root} is a git work tree (${outcome.detail}); skipping git operations for now.`,
      );
      lastUnansweredGitRepoProbeAt = kb.time.now();
      return 'unanswered';
    }

    lastUnansweredGitRepoProbeAt = null;
    cachedIsGitRepo = outcome.kind === 'answered' && outcome.status === 0;
    return cachedIsGitRepo ? 'yes' : 'no';
  }

  /**
   * Every git-sync operation gates on this, so a wrong `false` is not a degraded mode — it is the KB silently
   * ceasing to be version-controlled, with no commit, no push, and nothing said. That is what caching every
   * failure produced: one `EAGAIN` under fork pressure, or one 5s timeout on a busy disk, and the answer was
   * `false` for the lifetime of the daemon.
   *
   * So only an answer is cached. A non-answer is remembered with an expiry instead — long enough that a wedged
   * environment is not re-probed on each of the seven call sites, short enough that a recovered one heals
   * without a restart. Within the window the operations are skipped, which is the same conservative direction
   * as before; the difference is that it ends.
   *
   * This is `probeIsGitRepo` collapsed to the boolean its six other call sites need — `'no'` and `'unanswered'`
   * are the same "skip this operation" to them. `gitSync` below is the one caller that needs the third answer
   * kept apart, so it reads `probeIsGitRepo` directly instead of this wrapper.
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
      // sync is a cycle that did not do the thing they enabled, and it used to be indistinguishable from a
      // repository with no remote configured. Nothing is remembered — the scheduler asks again next cycle,
      // which is why this needs no interval where `isGitRepo` does. `launch-refused` (git itself could not be
      // launched) folds in here rather than returning `'no'` silently: it says exactly as little about whether
      // a remote exists as a timeout does.
      const detail = outcome.kind === 'no-answer' ? outcome.detail : outcome.code;
      backendLog.warn(`[KB] git sync could not list remotes for ${root} (${detail}); skipping this cycle.`);
      return 'unanswered';
    }
    if (outcome.status !== 0) {
      return 'no';
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

  function ensureKbMergeDrivers(): void {
    try {
      appendMissingManagedLines(join(root, '.gitattributes'), GITATTRIBUTES_HEADER, GITATTRIBUTES_ENTRIES);
    } catch {
      // best-effort
    }

    try {
      if (!isGitRepo()) {
        return;
      }
      git(['config', 'merge.coral-entity-graph.name', 'Coral entity graph CRDT merge driver'], 5000);
      git(['config', 'merge.coral-entity-graph.driver', buildEntityGraphMergeDriverCommand()], 5000);
      git(['config', 'merge.coral-frontmatter.name', 'Coral markdown frontmatter/body merge driver'], 5000);
      git(['config', 'merge.coral-frontmatter.driver', buildFrontmatterMergeDriverCommand()], 5000);
      git(['config', 'rebase.backend', 'merge'], 5000);
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

  function quarantineConflictPaths(
    paths: readonly string[],
    recoveryRef: string,
  ): Array<{ entryId: KbEntryId; slug: string; path: string }> {
    const detectedAt = nowIsoString(kb.time);
    const quarantined: Array<{ entryId: KbEntryId; slug: string; path: string }> = [];
    const seen = new Set<KbEntryId>();
    for (const path of paths) {
      const entry = entryForConflictPath(path);
      if (entry === null || seen.has(entry.entryId)) {
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
    return quarantined;
  }

  function logRecoveryOutcome(recoveryRef: string, branch: string, quarantined: readonly { slug: string }[]): void {
    const quarantinedSlugs = quarantined.map((entry) => entry.slug).join(', ');
    backendLog.warn(
      [
        `[KB] git rebase body conflict recovered on ${branch}; local commits preserved at ${recoveryRef}; worktree reset to origin/${branch}.`,
        quarantinedSlugs.length === 0 ? undefined : `Quarantined entries: ${quarantinedSlugs}.`,
        `List recovery refs with 'git for-each-ref ${RECOVERY_REF_NAMESPACE}'.`,
        `After landing or discarding recovered work, cleanup with 'git update-ref -d ${recoveryRef}'.`,
        `Coral keeps the newest ${RECOVERY_REF_KEEP_PER_BRANCH} recovery refs per branch automatically.`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' '),
    );
  }

  function recoverRebaseConflict(branch: string, conflictState: GitConflictState): boolean {
    try {
      git(['rebase', '--abort'], 10000);
    } catch (error: unknown) {
      backendLog.error(
        '[KB] git rebase conflict recovery could not abort the rebase; leaving worktree untouched',
        error,
      );
      return false;
    }

    let recoveryRef: string | null;
    try {
      recoveryRef = preserveHeadOnRecoveryRef(branch);
    } catch (error: unknown) {
      backendLog.error(
        '[KB] git rebase conflict recovery could not preserve local commits; leaving worktree untouched',
        error,
      );
      return false;
    }
    if (recoveryRef === null) {
      backendLog.error('[KB] git rebase conflict recovery could not read HEAD; leaving worktree untouched');
      return false;
    }

    let quarantined: Array<{ entryId: KbEntryId; slug: string; path: string }>;
    try {
      quarantined = quarantineConflictPaths(conflictState.paths, recoveryRef);
    } catch (error: unknown) {
      backendLog.error(
        `[KB] git rebase conflict recovery preserved local commits at ${recoveryRef} but could not write conflict quarantine; leaving worktree untouched`,
        error,
      );
      return false;
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
      return false;
    }

    logRecoveryOutcome(recoveryRef, branch, quarantined);
    return true;
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

  async function continueOrRecoverRebase(
    branch: string,
    signal?: AbortSignal,
  ): Promise<'continued' | 'llm-resolved' | 'recovered' | 'failed'> {
    let usedLlmConflictResolution = false;

    for (let attempt = 0; attempt < 64; attempt += 1) {
      if (signal?.aborted) {
        abortInProgressRebase();
        return 'failed';
      }

      if (hasConflictMarkers()) {
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
        return recoverRebaseConflict(branch, detectConflictState()) ? 'recovered' : 'failed';
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

    const conflictState = detectConflictState();
    if (conflictState.hasMarkers || isRebaseInProgress()) {
      return recoverRebaseConflict(branch, conflictState) ? 'recovered' : 'failed';
    }

    return 'failed';
  }

  async function gitSync(signal?: AbortSignal): Promise<GitSyncResult> {
    // `isGitRepo`/`isGitSyncEnabled` collapse "no" and "could not tell" to the same `false` — fine for a
    // gate that only skips this operation, wrong here: `{ kind: 'no-change' }` tells the Corpus authority
    // nothing changed, and a probe that could not be answered observed nothing about that at all.
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
        if (rebaseResult === 'recovered') {
          usedConflictRecovery = true;
        }
        if (rebaseResult === 'llm-resolved') {
          usedLlmConflictResolution = true;
        }
      }
    } catch {
      // Offline or no remote; continue with local state.
    }

    const headAfterSync = readHead();
    if (headBeforeSync === headAfterSync) {
      return { kind: 'no-change' };
    }
    if (usedConflictRecovery) {
      return { kind: 'ambiguous' };
    }
    if (usedLlmConflictResolution) {
      return { kind: 'ambiguous' };
    }
    if (headBeforeSync === null || headAfterSync === null) {
      return { kind: 'ambiguous' };
    }

    return diffKbPathsBetweenRevisions(headBeforeSync, headAfterSync);
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
