import { join } from 'node:path';
import type { KbRuntime } from '../contracts.js';
import { runCurateClaude } from './operations.js';
import type { GitSyncRuntimePicks, SpawnCliFn } from './types.js';

const GITIGNORE_ENTRIES = ['data/', '.obsidian/'];
const GITIGNORE_HEADER = '# Coral KB runtime (device-local, auto-managed)';
const DEFERRED_COMMIT_DELAY_MS = 60_000;
const KB_GIT_DIFF_PATHS = ['notes/', 'sources/', 'principles/', 'communities/', '.entity-graph.json'];

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

export type GitSyncController = {
  ensureKbGitignore(): void;
  gitSync(signal?: AbortSignal): Promise<GitSyncResult>;
  gitPush(): Promise<void>;
  gitAutoCommit(message: string): void;
  gitAutoCommitAsync(message: string): Promise<void>;
  scheduleDeferredCommit(): void;
  cancelDeferredCommit(): void;
};

export function createGitSyncController({
  kb,
  spawnCli,
  processPort,
  storagePort,
  envPort,
}: {
  kb: KbRuntime;
  spawnCli: SpawnCliFn;
} & GitSyncRuntimePicks): GitSyncController {
  let cachedIsGitRepo: boolean | null = null;
  let deferredCommitTimer: NodeJS.Timeout | null = null;
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
    try {
      git(['commit', '-m', message], 10000);
    } catch {
      git(['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-m', message], 10000);
    }
  }

  function isGitRepo(): boolean {
    if (cachedIsGitRepo !== null) {
      return cachedIsGitRepo;
    }
    try {
      git(['rev-parse', '--is-inside-work-tree'], 5000);
      cachedIsGitRepo = true;
    } catch {
      cachedIsGitRepo = false;
    }
    return cachedIsGitRepo;
  }

  function isGitSyncEnabled(): boolean {
    if (envPort.get('CORAL_KB_GIT_SYNC') !== '1') {
      return false;
    }
    try {
      return git(['remote'], 5000).trim().length > 0;
    } catch {
      return false;
    }
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
      git(['diff', '--check'], 5000);
      return false;
    } catch {
      return true;
    }
  }

  function kbGitPaths(): string[] {
    return ['notes/', 'sources/', 'principles/', 'communities/', '.entity-graph.json', '.gitignore'].filter((entry) =>
      storagePort.existsSync(join(root, entry.replace(/\/$/, ''))),
    );
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

    for (const line of raw.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
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
      const raw = git(['diff', '--name-status', '--find-renames', `${previousHead}..${nextHead}`, '--', ...KB_GIT_DIFF_PATHS], 10000);
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

  function ensureKbGitignore(): void {
    const gitignorePath = join(root, '.gitignore');
    try {
      let existing = '';
      try {
        existing = storagePort.readFileSync(gitignorePath, 'utf-8');
      } catch {
        /* no file */
      }
      const lines = existing.split('\n');
      const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.some((line) => line.trim() === entry));
      if (missing.length === 0) {
        return;
      }

      const suffix = `${GITIGNORE_HEADER}\n${missing.join('\n')}\n`;
      const newContent = existing.length === 0 ? suffix : `${existing}\n${suffix}`;
      storagePort.writeAtomicSync(gitignorePath, newContent);
    } catch {
      // best-effort
    }
  }

  async function resolveConflictsWithClaude(signal?: AbortSignal): Promise<boolean> {
    const prompt =
      'Git rebase conflict in KB repository. Resolve all conflicts in the working tree:' +
      ' keep both changes where possible, prefer the incoming (remote) version for' +
      ' frontmatter metadata (tags, principles, updatedAt), and preserve local body' +
      ' content. Stage all resolved files with git add.';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await runCurateClaude(
          kb,
          spawnCli,
          prompt,
          ['--permission-mode', 'bypassPermissions', '--model', 'sonnet'],
          signal,
        );
      } catch {
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
        // Another conflicting commit may remain.
      }
    }

    return false;
  }

  async function gitSync(signal?: AbortSignal): Promise<GitSyncResult> {
    if (!isGitRepo() || !isGitSyncEnabled()) {
      return { kind: 'no-change' };
    }

    cancelDeferredCommit();
    const branch = getDefaultBranch();
    const headBeforeSync = readHead();
    let usedConflictResolution = false;

    try {
      await gitAsync(['fetch', 'origin'], 30000);

      try {
        if (git(['status', '--porcelain'], 5000).trim().length > 0) {
          git(['add', '-A'], 5000);
          gitCommit('auto: pre-sync snapshot');
        }
      } catch {
        // commit failure — proceed with rebase anyway
      }

      try {
        await gitAsync(['rebase', `origin/${branch}`]);
      } catch {
        usedConflictResolution = true;
        if (!(await resolveConflictsWithClaude(signal))) {
          try {
            git(['rebase', '--abort'], 5000);
          } catch {
            /* no-op */
          }
        }
      }
    } catch {
      // Offline or no remote; continue with local state.
    }

    const headAfterSync = readHead();
    if (headBeforeSync === headAfterSync) {
      return { kind: 'no-change' };
    }
    if (usedConflictResolution) {
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
    if (!isGitRepo() || deferredCommitTimer !== null) {
      return;
    }
    deferredCommitTimer = setTimeout(() => {
      deferredCommitTimer = null;
      void gitAutoCommitAsync('auto: kb mutation');
    }, DEFERRED_COMMIT_DELAY_MS);
    deferredCommitTimer.unref?.();
  }

  function cancelDeferredCommit(): void {
    if (deferredCommitTimer !== null) {
      clearTimeout(deferredCommitTimer);
      deferredCommitTimer = null;
    }
  }

  return {
    ensureKbGitignore,
    gitSync,
    gitPush,
    gitAutoCommit,
    gitAutoCommitAsync,
    scheduleDeferredCommit,
    cancelDeferredCommit,
  };
}
