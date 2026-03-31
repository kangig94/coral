import { ensureGitRepository } from "./git.js";

export function resolveWorkspaceRoot(cwd: string): string {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
