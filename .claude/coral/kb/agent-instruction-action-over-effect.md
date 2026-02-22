# Agent Instruction: Action Directive Over Effect Description

## Rule
When writing agent protocols that expect visible text output (not tool calls), phrase the instruction as an explicit action ("Say it as plain text") rather than describing the intended effect ("It stays in your own context only"). Effect-describing phrasing risks the LLM interpreting it as "don't output anything visible," suppressing the output entirely.

## Why
LLMs optimize for compliance with stated outcomes. If the instruction says "this stays in your context only," the model may reason that producing no visible output is the safest way to satisfy that constraint. This defeats the purpose of chain-of-thought monologue, self-reflection, or any behavior where visible (but non-tool-call) output is the goal.

## Pattern
```markdown
# RIGHT — action directive
React out loud in character (1-3 sentences). Say it as plain text;
do not use any tool for this.

# WRONG — effect description
React internally. It stays in your own context only.
# ^ LLM may suppress output entirely
```

Applies to any agent definition where the desired behavior is "produce text output that is NOT a tool call."
