---
name: discuss
description: Moderated multi-agent discussion via Agent Teams
argument-hint: "[--user] [topic] [--hints axis1:pos1,pos2 axis2:pos1,pos2]"
---

# Moderated Multi-Agent Discussion

Start a structured discussion with AI agents.
Pass `--user` to participate as a human observer.

## Pre-flight Check

Before any other action, verify the Agent Teams environment:

1. **Check environment variable**: The discuss feature requires Agent Teams.
   If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is not set to `1`, inform the user:

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

2. **Analyze topic**: Determine team composition (roles, debate mode detection)
   and prepare persona inputs.
   - Identify the professional domain and relevant diversity axes for the topic.
   - **Demographics**: If geographic origin matters
     (e.g., global industry practice, policy comparison):
     estimate practitioner origin distribution,
     pass `demographics: { origin_weights: { ... }, outlier_ratio: 0.2 }` to `_1_seed`.
     If origin is not the relevant axis:
     omit `demographics` and encode diversity directly as a controversy axis.
   - **Briefs**: Write a 1-2 sentence background differentiation guide per slot
     (e.g., "20-year veteran with regulatory background",
     "Early-career startup founder").
     These seed each persona's Expertise section.
   - **Name cultures**: Assign a distinct `name_culture` per agent (no duplicates).
     Pick from diverse regions
     (e.g., Korean, Nigerian, Brazilian, German, Indian, Japanese, Egyptian).
     If demographics provided `suggested_origin`, use that instead.

3. **Generate personas**: Call `discuss_lead({ op: '_1_seed', ... })`
   then spawn `persona-generator` agents in parallel (one per role, `model: "sonnet"`).
   Include from each assignment:
   - `brief` (from step 2) as Expertise seed.
   - `name_culture` (from step 2 or `suggested_origin`) - never omit.
   - `positions` and `tone` from `_1_seed` assignments.
   - If `is_outlier`: add context in `brief`
     (e.g., "unusual background for this domain - give a compelling career path").

4. **Initialize**: Build the agents list.
   If `--user` flag was passed, add the following to the agents list:
   `{ name: 'user', persona: '# User — Human Participant\nHuman observer with real-time participation via /bid skill.', participation: 'observer' }`.
   Call `discuss_lead({ op: "_2_create", ..., min_bid_delay_ms: 10000 })` if `--user`,
   else `min_bid_delay_ms: 0`. Get `session_id`.

5. **Write active session file** (only if `--user`):
   Write `.claude/coral/discuss/active-user-session.json`
   with `{ session_id, team_name }`.
   This enables the `/bid` skill to find the session.

6. **Create team and spawn teammates**:
   Create Agent Team `coral-dc-{session_id}`. Spawn ALL teammates:
   - **discuss-lead** (always):
     `Task(subagent_type: 'coral:discuss-lead', team_name, name: 'discuss-lead', prompt: "Run discussion for session {session_id}. has_user_observer: {true if --user, false otherwise}. After each speech, SendMessage the full speech content to team lead.")`
   - **Discussants** (AI agents only):
     One per agent with `participation: 'required'`,
     using `name: 'dc-{agent_name}'` (e.g., agent `park` → teammate `dc-park`).
     Skip `participation: 'observer'` agents —
     they interact via `/bid`, not as spawned teammates.
     Each discussant prompt must include:
     - Discussion topic and relevant context
       (background information, constraints, or framing
       that the main context gathered during topic analysis in step 2)
     - Their full persona (generated in step 3)
     - Session ID

7. **If `--user`**: Return immediately to the user:
   "Discussion started! Use `/bid <score>, <thought>` to submit a bid,
   or `/bid <your speech>` when you win the floor."

8. **Receive speeches and evaluate convergence**:
   Main context receives round-by-round speech messages from discuss-lead via SendMessage.
   Display each speech as it arrives.
   After each complete round, apply a two-layer convergence assessment:

   **Layer 1 — Procedural conditions** (necessary but not sufficient for termination):
   - Have all participants spoken at least once?
   - Have major rebuttals been addressed (not necessarily resolved)?
   - Has the user signaled they want to end?

   **Layer 2 — Content-level convergence** (distinguish three states):

   | State | Indicators | Action |
   |-------|-----------|--------|
   | **Active divergence** | New frameworks introduced, fundamentally new questions raised, positions shifting significantly | Continue — discussion is still opening up |
   | **Productive refinement** | New distinctions within existing positions, cross-pollination between frameworks, meta-level questions emerging, participants revising their own positions | **Continue** — refinement produces genuine insight |
   | **True repetition** | Same arguments restated without new evidence or distinctions, no participant revises their position, cross-engagement decreases | Convergence reached — proceed to step 9 |

   **Refinement ≠ repetition.**
   A participant deepening their position with a new distinction
   (e.g., "saturation ≠ exhaustion")
   or a new meta-question (e.g., "who validates the validator?")
   is productive refinement, not convergence.
   Only terminate when refinement itself stops producing new distinctions.

   **Default to continuing** —
   if uncertain whether the current state is refinement or repetition,
   let the discussion run.
   Premature termination is worse than an extra round.

9. **On discussion end**: Main context owns termination.
   When convergence is reached:
   1. Call `discuss_lead({ op: '_4_transcript', session, mode: 'full' })`
      to read the full transcript.
   2. Compose a synthesis.
      Must include: Key Agreements, Key Splits, Recommended Resolution.
   3. Call `discuss_lead({ op: '_7_end', session })` to end the session.
   4. Call `discuss_lead({ op: '_8_synthesize', session, synthesis })`
      to record the synthesis.
   5. discuss-lead's next `_3_step` returns `phase=ended` → it goes idle.
   6. Present the synthesis to the user.
   7. If `--user`, delete `.claude/coral/discuss/active-user-session.json`.

## Context Enhancement

From the user's request, identify:
- Discussion topic (required - gather interactively if not provided)
- `--user` flag (human participation mode)
- Preferred team size (default: 4–6 AI agents)
- Whether it's a pro/con debate (triggers debate mode)
- Any specific perspectives or roles requested
- Any controversy hints provided via `--hints`
  (pre-specified axes to include in Phase 1 analysis)

## Error Policy

If `agents/discuss-lead.md` cannot be read, report the error to the user.
