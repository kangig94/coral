# Merge Policy

Deterministic rules for handling existing files during init-project execution.

## Per-Artifact Merge Rules

### .claude/agents/*.md

| Condition | Action |
|-----------|--------|
| Same-name file exists | **Skip**. Notify user: "Skipped {name}.md - already exists." |
| File does not exist | Create from template or domain reference |
| User requests refresh | Overwrite with latest template content |

### .claude/CLAUDE.md

| Condition | Action |
|-----------|--------|
| File does not exist | Create slim hub from `templates/CLAUDE.md.template` |
| File exists | **Skip** (may be monolithic or customized). Notify user. |

### .claude/rules/*.md

| Condition | Action |
|-----------|--------|
| Same-name file exists | **Skip**. Notify user: "Skipped rules/{name}.md - already exists." |
| File does not exist | Create from rule template |

No auto-migration of monolithic CLAUDE.md. Users with existing monolithic files keep them - the rules files are additive and coexist. Users can manually slim their CLAUDE.md when ready.

### docs/*.md

| Condition | Action |
|-----------|--------|
| File exists, merge rule = "skip" (default) | **Skip**. Notify user: "Skipped docs/{name}.md - already exists." |
| File exists, merge rule = "enhance" | **Append** missing sections identified in the plan. Do not modify existing content. Notify user: "Enhanced docs/{name}.md - added {section names}." |
| File does not exist | Create with real content |

### .gitignore

| Condition | Action |
|-----------|--------|
| File does not exist | Create with Coral block |
| File exists, has `# Coral` block | **Skip** (already configured) |
| File exists, no `# Coral` block | Append Coral block at end |

**Coral block format**:
```
# Coral
.kb/
.claude/coral
```

### .kb/

| Condition | Action |
|-----------|--------|
| Directory exists | No-op |
| Directory does not exist | Create with `mkdir -p` |


## Idempotency Guarantee

Running `/coral:init-project` twice in succession produces no additional changes:
- Agents: skipped (already exist)
- CLAUDE.md: skipped (already exists)
- Rules files: skipped (already exist)
- docs/: skipped (already exist), or enhanced sections already present (no duplicate append)
- .gitignore: Coral block already present (skipped)
- KB directory: already exists (no-op)
