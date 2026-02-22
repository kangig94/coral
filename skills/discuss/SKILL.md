---
name: discuss
description: Moderated multi-agent discussion via Agent Teams
argument-hint: "[topic] [--hints axis1:pos1,pos2 axis2:pos1,pos2]"
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

   Then STOP - do not proceed with discussion setup.

## Execution

1. **If no topic provided**: Use AskUserQuestion to interactively gather:
   - Discussion topic (required)
   - Number of participants (2-8, default: 4)
   - Whether it's a debate (pro/con) or open discussion
   - Any specific roles or perspectives to include

2. **Load protocol**: Read `agents/discuss-lead.md` to load the full discussion lead protocol. Execute the protocol directly — do NOT spawn it as a subagent.
3. **Analyze topic**: Determine team composition (roles, debate mode detection)
4. **Generate personas**: Spawn `persona-generator` agents in parallel (one per role).
   Include `persona_seed` from each assignment in the prompt as a creative variation hint
   (e.g., "Your persona seed is 3847291. Use this as a source of creative variation in
   name choices, background details, and communication quirks.").
5. **Initialize**: Call `discuss_lead({ op: "_2_create", ... })` with generated personas → get `session_id`
6. **Spawn teammates**: Create Agent Team `coral-dc-{session_id}`, spawn `discussant` teammates
7. **Run discussion**: Execute `discuss_lead(_3_step)` rounds — bid collection → winner resolve → speech escalation loop until termination
8. **Synthesize**: Call `discuss_lead({ op: "_7_end", ... })`, read full transcript via `_4_transcript`, present structured summary

## Termination Policy

**Default**: Keep calling `_3_step` rounds until the system returns `phase=ended` (automatic termination via epoch exhaustion).

**Early manual termination** (`_7_end`) is allowed only when ALL conditions are met:
1. Every agent has spoken at least **twice**
2. Second-round speeches **reference or build on** earlier positions rather than introducing entirely new topics
3. At least one agent has explicitly proposed a synthesis or convergence point

Before calling `_7_end`, always check: is there an agent who hasn't had a second turn yet? If so, continue rounds to give them the opportunity.

## Context Enhancement

From the user's request, identify:
- Discussion topic (required - gather interactively if not provided)
- Preferred team size (default: 4–6 agents)
- Whether it's a pro/con debate (triggers debate mode)
- Any specific perspectives or roles requested
- Any controversy hints provided via `--hints` (pre-specified axes to include in Phase 1 analysis)

## Error Policy

If `agents/discuss-lead.md` cannot be read, report the error to the user.
