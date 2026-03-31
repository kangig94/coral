import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.js";
import { runCommand, runCommandChecked, type RunCommandOptions } from "./process.js";

const MAX_UNTRACKED_BYTES = 24 * 1024;

interface CommandResult {
  command: string;
  args: string[];
  status: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: (Error & { code?: string }) | null;
}

type CommandOptions = RunCommandOptions;

interface WorkingTreeState {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  isDirty: boolean;
}

interface ReviewTarget {
  mode: "working-tree" | "branch";
  label: string;
  baseRef?: string;
  explicit: boolean;
}

interface ResolveReviewTargetOptions {
  scope?: string;
  base?: string | null;
}

interface ReviewContext {
  cwd: string;
  repoRoot: string;
  branch: string;
  target: ReviewTarget;
  mode: "working-tree" | "branch";
  summary: string;
  content: string;
}

interface CollectedContext {
  mode: "working-tree" | "branch";
  summary: string;
  content: string;
}

function git(cwd: string, args: string[], options: CommandOptions = {}): CommandResult {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd: string, args: string[], options: CommandOptions = {}): CommandResult {
  return runCommandChecked("git", args, { cwd, ...options });
}

export function ensureGitRepository(cwd: string): string {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd: string): string {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd: string): string {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd: string): string {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd: string): WorkingTreeState {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd: string, options: ResolveReviewTargetOptions = {}): ReviewTarget {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title: string, body: string): string {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd: string, relativePath: string): string {
  const absolutePath = path.join(cwd, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd: string, state: WorkingTreeState): CollectedContext {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  const parts = [
    formatSection("Git Status", status),
    formatSection("Staged Diff", stagedDiff),
    formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untrackedBody)
  ];

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n")
  };
}

function collectBranchContext(cwd: string, baseRef: string): CollectedContext {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const diff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]).stdout;

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", diff)
    ].join("\n")
  };
}

export function collectReviewContext(cwd: string, target: ReviewTarget): ReviewContext {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(cwd);
  const currentBranch = getCurrentBranch(cwd);
  let details: CollectedContext;

  if (target.mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef!);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details
  };
}
