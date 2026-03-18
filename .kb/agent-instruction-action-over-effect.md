# Agent Behavior: Enforce via Protocol, Not Prompt

## Rule
If agent behavior is critical, enforce it through mandatory tool parameters — not prompt instructions. Action directives ("React out loud") are better than effect descriptions ("It stays in your context"), but agents still routinely skip both. Only tool-level enforcement (required fields validated by Zod) guarantees compliance.

## Why
LLMs treat prompt instructions as soft guidance. Even well-phrased action directives get consistently ignored under cognitive load (e.g., mid-discussion bidding). A mandatory tool parameter is protocol-enforced: the operation fails without it, so compliance is structural rather than behavioral.

## Pattern
```markdown
# BEST — tool parameter enforcement
discuss({ op: 'bid', session, agent_name, score, thought })
# ^ thought is Zod-required; bid fails without it

# BETTER — action directive (still unreliable)
React out loud in character (1-3 sentences). Say it as plain text;
do not use any tool for this.

# WORST — effect description
React internally. It stays in your own context only.
# ^ LLM may suppress output entirely
```

Real-world evidence: the "react out loud" pattern in `agents/discussant.md` was consistently ignored by all discussant agents across multiple sessions. Replacing it with a mandatory `thought` field on the bid op achieved 100% compliance immediately.
