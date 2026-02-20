---
name: discuss
description: Moderated multi-agent discussion via Agent Teams
argument-hint: "[topic]"
---

# Moderated Multi-Agent Discussion

Start a structured discussion with AI agents, each with a unique persona.

## Execution

1. **Load protocol**: Read `agents/discuss-lead.md` to load the full discussion lead protocol
2. **Analyze topic**: Determine team composition (roles, debate mode detection)
3. **Generate personas**: Spawn `persona-generator` agents in parallel (one per role)
4. **Initialize**: Call `discuss_create` with generated personas → get `session_id`
5. **Spawn teammates**: Create Agent Team `coral-dc-{session_id}`, spawn `discussant` teammates
6. **Run discussion**: Execute bidding → resolve → speak loop until termination
7. **Synthesize**: Call `discuss_end`, read full transcript, present structured summary

## Context Enhancement

From the user's request, identify:
- Discussion topic (required)
- Preferred team size (default: 4–6 agents)
- Whether it's a pro/con debate (triggers debate mode)
- Any specific perspectives or roles requested

## Error Policy

If `agents/discuss-lead.md` cannot be read, report the error to the user.
