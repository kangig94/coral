---
name: discuss
description: Moderated multi-agent discussion via Agent Teams
argument-hint: "[topic]"
---

# Moderated Multi-Agent Discussion

Start a structured discussion with AI agents, each with a unique persona.

## Pre-flight Check

Before any other action, verify the Agent Teams environment:

1. **Check environment variable**: The discuss feature requires Agent Teams. If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is not set to `1`, inform the user:

   ```
   The discuss feature requires Agent Teams to be enabled.

   Add this to your .claude/settings.json:
   {
     "env": {
       "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
     }
   }
   ```

   Then STOP — do not proceed with discussion setup.

## Execution

1. **If no topic provided**: Use AskUserQuestion to interactively gather:
   - Discussion topic (required)
   - Number of participants (2-8, default: 4)
   - Whether it's a debate (pro/con) or open discussion
   - Any specific roles or perspectives to include

2. **Load protocol**: Read `agents/discuss-lead.md` to load the full discussion lead protocol
3. **Analyze topic**: Determine team composition (roles, debate mode detection)
4. **Generate personas**: Spawn `persona-generator` agents in parallel (one per role)
5. **Initialize**: Call `discuss_create` with generated personas → get `session_id`
6. **Spawn teammates**: Create Agent Team `coral-dc-{session_id}`, spawn `discussant` teammates
7. **Run discussion**: Execute bidding → `discuss_wait(all_bids)` auto-resolve → speak loop until termination
8. **Synthesize**: Call `discuss_end`, read full transcript, present structured summary

## Context Enhancement

From the user's request, identify:
- Discussion topic (required — gather interactively if not provided)
- Preferred team size (default: 4–6 agents)
- Whether it's a pro/con debate (triggers debate mode)
- Any specific perspectives or roles requested

## Error Policy

If `agents/discuss-lead.md` cannot be read, report the error to the user.
