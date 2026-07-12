# Merge Policy

Deterministic rules for handling existing files during init-project execution.

## Per-Artifact Merge Rules

### .claude/agents/*.md

| Condition | Action |
|-----------|--------|
| Same-name file exists, no stale findings | **Skip**. Notify user: "Skipped {name}.md - already exists." |
| Same-name file exists, merge rule = "update" | **Patch**: apply targeted edits specified in the plan. Preserve all non-cited content. Notify user: "Updated {name}.md — {summary of changes}." |
| File does not exist | Create from template or domain reference |
| User requests refresh | Overwrite with latest template content |

### .claude/CLAUDE.md

| Condition | Action |
|-----------|--------|
| File does not exist | Create slim hub from `templates/CLAUDE.md.template` |
| File exists, no stale findings | **Skip** (may be monolithic or customized). Notify user. |
| File exists, merge rule = "update" | **Patch**: apply targeted edits specified in the plan. Preserve all non-cited content. Notify user: "Updated CLAUDE.md — {summary of changes}." |

### .claude/rules/*.md

| Condition | Action |
|-----------|--------|
| Same-name file exists, no stale findings | **Skip**. Notify user: "Skipped rules/{name}.md - already exists." |
| Same-name file exists, merge rule = "update" | **Patch**: apply targeted edits specified in the plan. Preserve all non-cited content. Notify user: "Updated rules/{name}.md — {summary of changes}." |
| File does not exist | Create from rule template |

No auto-migration of monolithic CLAUDE.md. Users with existing monolithic files keep them - the rules files are additive and coexist. Users can manually slim their CLAUDE.md when ready.

### docs/*.md

| Condition | Action |
|-----------|--------|
| File exists, merge rule = "skip" (default) | **Skip**. Notify user: "Skipped docs/{name}.md - already exists." |
| File exists, merge rule = "enhance" | **Append** missing sections identified in the plan. Do not modify existing content. Notify user: "Enhanced docs/{name}.md - added {section names}." |
| File exists, merge rule = "update" | **Patch**: apply targeted edits specified in the plan. Preserve all non-cited content. Notify user: "Updated docs/{name}.md — {summary of changes}." |
| File does not exist | Create with real content |

### The "update" Merge Rule

"Update" is a targeted patch — not a rewrite. It applies only when the analysis identifies specific stale content in an existing file.

**Requirements for the plan**: Each "update" artifact entry must include:
- The analysis finding that drives the update (severity + provenance)
- What content is stale (quote or describe the incorrect content)
- What the correct content should be (the replacement)

**Execution**: Read the existing file, apply only the specified edits (Edit tool), leave everything else untouched. Each changed line must trace to an analysis finding.

**Distinction from other rules**:
- "skip" = don't touch
- "create" = file doesn't exist, write from scratch
- "enhance" = append new sections, never modify existing content
- "update" = modify specific stale content, preserve everything else

### Shared KB (`~/.coral/kb/notes/`)

| Condition | Action |
|-----------|--------|
| KB already exists | No-op |
| KB missing | Do not create or modify it as part of init-project |


## Idempotency Guarantee

Running `/coral:init-project` twice in succession produces no additional changes:
- Agents: skipped (already exist), or updates already applied (edits are idempotent)
- CLAUDE.md: skipped (already exists), or updates already applied
- Rules files: skipped (already exist), or updates already applied
- docs/: skipped (already exist), enhanced sections already present (no duplicate append), or updates already applied
