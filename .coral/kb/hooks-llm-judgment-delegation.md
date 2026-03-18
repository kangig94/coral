# Hook Detection vs LLM Judgment Delegation

## Rule
When a hook needs to distinguish user intent that depends on conversation context (not just syntax), the hook should only perform coarse detection (e.g., "is this ralph?") and delegate the fine-grained judgment to the LLM. Use `hookSpecificOutput.additionalContext` to pass hook-created state (file paths, session IDs) into Claude's context so the LLM can act on it.

## Why
Natural language intent is ambiguous without conversation context. `/ralph 구현하자` could be a prompt or a plan reference — only the LLM seeing the full conversation can decide. Rule-based arg parsing in hooks will misclassify edge cases.

## Pattern
```
# RIGHT: Hook does coarse detection, LLM decides
Hook (UserPromptSubmit):
  detect "ralph" → create state file → output path via additionalContext
SKILL.md (LLM):
  read context → plan mode? delete state file : keep and configure it
Stop hook:
  state file exists? → loop : allow exit

# WRONG: Hook tries to parse intent from args
Hook (UserPromptSubmit):
  detect "ralph" → strip flags → check if remaining text is a prompt
  → FAILS on "이거 진행해줘" (refers to plan in context)
```
