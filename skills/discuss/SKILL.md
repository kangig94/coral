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

2. **Load protocol**: Read `agents/discuss-lead.md` to load the full discussion lead protocol. Execute the protocol directly - do NOT spawn it as a subagent.
3. **Analyze topic**: Determine team composition (roles, debate mode detection) and prepare persona inputs.
   - Identify the professional domain and relevant diversity axes for the topic.
   - **Demographics**: If geographic origin matters (e.g., global industry practice, policy comparison): estimate practitioner origin distribution, pass `demographics: { origin_weights: { ... }, outlier_ratio: 0.2 }` to `_1_seed`. If origin is not the relevant axis: omit `demographics` and encode diversity directly as a controversy axis.
   - **Briefs**: Write a 1-2 sentence background differentiation guide per slot (e.g., "20-year veteran with regulatory background", "Early-career startup founder"). These seed each persona's Expertise section.
   - **Name cultures**: Assign a distinct `name_culture` per agent (no duplicates). Pick from diverse regions (e.g., Korean, Nigerian, Brazilian, German, Indian, Japanese, Egyptian). If demographics provided `suggested_origin`, use that instead.
4. **Generate personas**: Spawn `persona-generator` agents in parallel (one per role, `model: "sonnet"`).
   Include from each assignment:
   - `brief` (from step 3) as Expertise seed.
   - `name_culture` (from step 3 or `suggested_origin`) - never omit.
   - `positions` and `tone` from `_1_seed` assignments.
   - If `is_outlier`: add context in `brief` (e.g., "unusual background for this domain - give a compelling career path").
   - Leave gender, age, and other details to the persona-generator LLM.
5. **Initialize**: Call `discuss_lead({ op: "_2_create", ... })` with generated personas → get `session_id`
6. **Spawn teammates**: Create Agent Team `coral-dc-{session_id}`, spawn `discussant` teammates
7. **Run discussion**: Execute `discuss_lead(_3_step)` rounds - bid collection → winner resolve → speech escalation loop until termination
8. **Synthesize**: Call `discuss_lead({ op: "_7_end", ... })`, read full transcript via `_4_transcript`, present structured summary

## Termination Policy

**Default**: Keep calling `_3_step` rounds until the system returns `phase=ended` (automatic termination via epoch exhaustion).

**Early manual termination** (`_7_end`) is allowed only when ALL conditions are met:
1. Every agent has spoken at least **twice**
2. Second-round speeches **reference or build on** earlier positions rather than introducing entirely new topics
3. At least one agent has explicitly proposed a synthesis or convergence point
4. The most recent speech does **not** contain an unanswered question directed at other participants

Before calling `_7_end`, always check:
- Is there an agent who hasn't had a second turn yet? If so, run more `_3_step` rounds instead.
- Does the last speech pose a question? If so, run more rounds - ending on an unanswered question cuts off dialogue unfairly.

## Context Enhancement

From the user's request, identify:
- Discussion topic (required - gather interactively if not provided)
- Preferred team size (default: 4–6 agents)
- Whether it's a pro/con debate (triggers debate mode)
- Any specific perspectives or roles requested
- Any controversy hints provided via `--hints` (pre-specified axes to include in Phase 1 analysis)

## Error Policy

If `agents/discuss-lead.md` cannot be read, report the error to the user.
