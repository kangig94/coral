# Merge Policy

Deterministic rules for handling existing files during init-project execution.

## Per-Artifact Merge Rules

### .claude/agents/*.md

| Condition | Action |
|-----------|--------|
| Same-name file exists | **Skip**. Notify user: "Skipped {name}.md — already exists." |
| File does not exist | Create from template or domain reference |
| User requests refresh | Overwrite with latest template content |

### .claude/CLAUDE.md

| Condition | Action |
|-----------|--------|
| File does not exist | Create from `templates/CLAUDE.md.template` |
| File exists WITH `<!-- CORAL:MANAGED -->` markers | Replace content within each marker pair. Preserve everything outside markers. |
| File exists WITHOUT markers | Append missing sections at the end of the file. Add markers around new content. |

**Section identification**: Match by marker ID (e.g., `CORAL:MANAGED:START:design-philosophy`). If a marker pair exists, replace its content. If a marker pair is missing, append the section.

### .claude/settings.local.json

| Condition | Action |
|-----------|--------|
| File does not exist | Create with detected permissions |
| File exists | Read existing JSON. Add new `permissions.allow` entries that don't already exist. Preserve all existing keys. Never remove entries. |

**Array handling**: Deduplicate by exact string match. Preserve ordering of existing entries, append new ones at end.

### docs/*.md

| Condition | Action |
|-----------|--------|
| File exists | **Skip**. Notify user: "Skipped docs/{name}.md — already exists." |
| File does not exist | Create with real content |

### .gitignore

| Condition | Action |
|-----------|--------|
| File does not exist | Create with Coral block |
| File exists, has `# Coral` block | **Skip** (already configured) |
| File exists, no `# Coral` block | Append Coral block at end |

**Coral block format**:
```
# Coral (device-local files)
.claude/coral/
!.claude/coral/kb/
```

### .claude/coral/kb/

| Condition | Action |
|-----------|--------|
| Directory exists | No-op |
| Directory does not exist | Create with `mkdir -p` |

### .claude/agents/TEMPLATE.md

| Condition | Action |
|-----------|--------|
| File exists | Skip |
| File does not exist | Create from template |

## Idempotency Guarantee

Running `/coral:init-project` twice in succession produces no additional changes:
- Agents: skipped (already exist)
- CLAUDE.md: marker content is identical (no diff)
- settings.local.json: no new entries to add (already present)
- docs/: skipped (already exist)
- .gitignore: Coral block already present (skipped)
- KB directory: already exists (no-op)
