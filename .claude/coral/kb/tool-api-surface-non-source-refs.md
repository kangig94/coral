# Tool API Changes: Update Non-Source Runtime Instruction Files
## Rule
When renaming, removing, or restructuring an MCP tool op (e.g., moving `wait` from per-provider ops to a standalone AX op), skill files, agent definitions, and KB entries that instruct agents how to call the tool must also be updated. These files pass through compilation and test suites unchanged — tests only verify server-side op handling, not whether skill/agent invocation instructions are current.
## Why
Silent runtime failures: agents following stale instructions send the old op name and receive `{ isError: true, error: "unknown_op" }`. The error looks like a transient tool failure, not a stale instruction. The review-orchestrator caught 9 stale references across 6 skills, 1 agent, and 2 KB files after a single op rename — none caught by build or test.
## Pattern
After any tool API change:
```bash
# Search non-source files for old invocation pattern
grep -r "old_op_name" skills/ agents/ .claude/coral/kb/ .claude/agents/

# Also check skills for hardcoded tool name variants
grep -r '"op".*"old_op"' skills/ agents/
```
Files to check:
- `skills/*/SKILL.md` — invocation instructions in protocols
- `agents/*.md` — agent-specific tool call examples
- `.claude/coral/kb/*.md` — patterns that describe how to call the tool
- `.claude/agents/*.md` — agent definitions that reference tool ops
