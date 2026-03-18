# Skill Tool Expansion Has Higher Protocol Authority Than Read Tool

## Rule
When a protocol must be strictly followed (planning, ralph, preplan), inject it via `Skill({ skill: "coral:plan" })` rather than `Read CORAL_SKILLS/plan/PROTOCOL.md`. The Skill tool expands the protocol inline at the **user-message level** of the current conversation. The Read tool injects content as a **tool_result** (lower behavioral priority). User-message content has higher LLM behavioral salience than tool_result content.

## Why
LLMs process user messages as the primary task directive and tool results as environmental context. A protocol injected via Read arrives as context rather than directive — under execution pressure, agents drift from it. The same protocol injected via Skill behaves like a direct user instruction and is followed more reliably. This is confirmed by the `llm-spawn-prompt-behavioral-priority.md` entry, which shows the same authority hierarchy between user messages and system prompts.

## Pattern
```markdown
# WRONG — protocol injected at tool_result level
Read `CORAL_SKILLS/plan/PROTOCOL.md`. Follow it exactly.
# Result: protocol treated as context, agent may drift under task pressure

# RIGHT — protocol injected at user-message level
Invoke `Skill({ skill: "coral:plan", args: "fix-auth-bug" })`
# Result: SKILL.md content expands inline as user message, followed as directive
```

**Important**: Skill expansion is inline (not a subagent). The expanded content runs in the current conversation context without increasing agent depth. Callers that previously read PROTOCOL.md directly can switch to Skill tool without worrying about depth limits.

**Role conflict**: If an embedded protocol has absolute constraints (e.g., "NEVER implement"), scope them to "within this protocol" when callers have subsequent implementation phases. The scoped wording is correct for standalone use and non-blocking for callers.
