# Codex CLI Landlock Sandbox Blocks Cross-Repo Access
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
Codex CLI uses Linux Landlock LSM to sandbox filesystem access. When started with `work_dir=/path/to/repo-A`, it only gets read/write access to repo-A's subtree. Cross-repo edits (modifying `../repo-B/` from a Codex session rooted in repo-A) are blocked by `Sandbox(LandlockRestrict)` before any command executes. Even with `work_dir` correctly pointing to the target repo, the sandbox initialization itself can fail in constrained environments (observed in coral-reef sessions).
## Why
Codex delegation fails silently or with opaque `Sandbox(LandlockRestrict)` errors. Tasks that span multiple repos cannot be delegated as a single Codex job. The failure also affects subagent shell invocations inside Codex.
## Pattern
```
# Wrong: single Codex job spanning two repos
codex({ work_dir: "/path/to/coral", prompt: "edit files in ../coral-reef/" })
# → Sandbox(LandlockRestrict)

# Right: separate Codex sessions per repo, or implement manually
codex({ work_dir: "/path/to/coral", prompt: "coral changes only" })
codex({ work_dir: "/path/to/coral-reef", prompt: "coral-reef changes only" })

# Fallback: if sandbox init fails even with correct work_dir, implement manually
```
