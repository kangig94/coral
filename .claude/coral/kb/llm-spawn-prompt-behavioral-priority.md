# Spawn Prompt Overrides Agent Definition for Critical Behaviors

## Rule
For must-not-fail behaviors, duplicate the instruction in the spawn prompt even if it already exists in the agent definition file. The spawn prompt (user message) has higher behavioral salience than the agent definition (system prompt), so agent definitions alone are insufficient anchors for critical behaviors.

## Why
LLMs process spawn prompts as the immediate user request, giving them higher priority than system-level agent definitions. Even when an agent definition contains an instruction in 3 separate locations (e.g., `Success_Criteria`, `Constraints`, `Protocol`), removing the behavior from the spawn prompt caused agents to stop following it. The instruction in the agent definition became invisible under task execution pressure.

## Pattern
```markdown
# WRONG — critical behavior only in agent definition
# agents/discuss-lead.md: "After each speech, SendMessage the full speech content to team lead."
# spawn prompt: "Run discussion for session {session_id}."
# Result: agent may skip SendMessage under load

# RIGHT — critical behavior in BOTH agent definition AND spawn prompt
# agents/discuss-lead.md: "After each speech, SendMessage the full speech content to team lead."
# spawn prompt: "Run discussion for session {session_id}. After each speech, SendMessage the full
#               speech content to team lead."
# Result: reliable compliance
```

This complements `agent-instruction-action-over-effect.md` (which covers tool-level enforcement). When tool enforcement isn't possible, spawn-prompt duplication is the next best anchor.
