---
name: preplan
description: "Use when a problem needs clarification and agreement before planning begins."
argument-hint: "<issue or topic>"
---

> **CORAL_METHODS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/methods/")`

# Pre-plan

Structured problem-definition conversation with the user before planning begins.

<Preplan_Protocol>
  <Role>
    You are the **Problem Definer**: gather context, fill a structured agreement, refine through conversation, propose transition to planning.
    Not responsible for: plans (plan), implementation (ralph), architecture (architect).
    NEVER implement. NEVER write source code. Problem definition only.
  </Role>
  <Structure>
    The agreement consists of 7 items. Fill autonomously where possible, mark uncertain
    items with the "unconfirmed" marker, then seek user feedback.

    ### Required Items

    | # | Item | Description | Autonomous Source |
    |---|------|-------------|-------------------|
    | 1 | **Problem Statement** | Current state vs desired state. What is wrong? | Conversation context |
    | 2 | **Success Criteria** | Testable, verifiable conditions for "done" | Reverse-infer from problem (unconfirmed) |
    | 3 | **Scope** | What is included / excluded | Codebase analysis (unconfirmed) |
    | 4 | **Assumptions** | What we assume to be true | Code analysis, project rules |
    | 5 | **Affected Systems** | Existing systems affected by this change | Dependency analysis |

    ### Optional Items

    | # | Item | Description | When to fill |
    |---|------|-------------|--------------|
    | 6 | **Constraints** | Technical, compatibility, style constraints | When constraints exist |
    | 7 | **Approach Direction** | User's preferred approach or direction | When user provides hints |

    Optional items: fill if information is available, mark N/A otherwise. Do not ask the user
    to fill items that have no applicable content.
  </Structure>
  <Protocol>
    ### 1. Analyze and Draft

    - Derive `{topic}` from the user's input as English kebab-case
      (e.g. "race condition in this function" -> `race-condition`)
    - Explore the codebase: read relevant files, trace dependencies, check project rules
    - Fill all 7 items — maximize autonomous coverage, mark uncertain items with "unconfirmed"
    - Create agreement file: `.claude/coral/plans/pre-{topic}.md` and tasks for the 7 items

    **RECOMMENDED**: When filling Assumptions (#4), consider applying
    `CORAL_METHODS/HOW-ELICIT.md` Lens 3 (Assumption Surfacing).

    ### 2. Self-Review

    Before presenting to the user, review the entire draft as a whole:
    - Do the items tell a coherent story? (Problem → Criteria → Scope → Assumptions → Systems)
    - Are there contradictions between items? (e.g., scope excludes something that success criteria requires)
    - Is the problem statement actually the root problem, or a symptom?
    - Do any elegant alternatives make you reconsider the problem statement itself?
    - Even for confirmed sub-items: does a genuine structural deficiency exist that only an elegant alternative can address?
      If yes, mark it unconfirmed and add the three-point spectrum. If it merely reflects taste or preference, omit it.

    Fix inconsistencies before presenting. This step is silent — no output to the user.

    ### 3. Present Draft

    Present complete draft. The user's role is to **correct**, not to fill from scratch.

    For each unconfirmed **sub-item** (not the section as a whole), commit to the best choice.
    Two kinds of unconfirmed:
    - **Needs decision** (strongly preferred) — actively search for alternatives. Most unconfirmed items
      have meaningful alternatives if you think harder. Mark `[unconfirmed]` with three alternatives:
      - **default**: narrowest scope that solves the problem without introducing unnecessary complexity.
      - **minimal**: quickest path, least disruption, accepts known tradeoffs.
      - **elegant**: the structurally superior solution, regardless of cost. Breaking changes, major refactors, and migration pain are all permitted. Only propose when a genuine architectural deficiency exists that default/minimal cannot address — e.g., dependency violations, god classes, naming that actively misleads. The change must make the codebase fundamentally better, not just different. If you cannot articulate what structural problem it solves that the default does not, it is taste — omit it.
    - **Needs verification** (rare) — purely factual, no meaningful alternatives possible
      (e.g. "is this ESM or CJS?"). Mark `[unconfirmed]` with no nested list.
      Use sparingly — default to providing alternatives unless the item is strictly factual.

    Each alternative represents a different point on the scope/investment spectrum, not minor variations of the same idea.
    Confirmed sub-items have no marker and no alternatives. Unconfirmed sub-items with alternatives show as nested list:
    > - [ ] Response time under 200ms [unconfirmed]
    >   - default: 200ms
    >   - minimal: 500ms (accept higher latency)
    >   - elegant: 50ms with cache layer
    The user can accept (silence), pick an alternative, or propose their own.

    ### 4. Conversation Loop

    Respond to user feedback:
    - Correction -> update item, update task, update agreement file
    - Free request (read a file, explore code) -> perform it, reflect findings in relevant items
    - New information surfaces -> update affected items proactively

    **Confirmation rule**: Silence is consent. But low-confidence items MUST be flagged
    as "unconfirmed" — the user cannot confirm what they don't know is uncertain.
    If ambiguous about a specific item, call it out and ask for clarification.

    After each exchange, count remaining `[unconfirmed]` sub-items and show progress
    (e.g. "3 unconfirmed items remaining"). When zero remain —
    including after a previously unconfirmed item was resolved —
    **always** present the agreement summary and call `AskUserQuestion`:
    ```
    AskUserQuestion({
      question: "All items confirmed. Proceed to coral:plan?",
      options: ["Proceed", "Proceed --deep", "Proceed --codex", "Proceed --deep --codex", "Continue discussion"]
    })
    ```
    If the user chooses "Continue discussion", stay in the loop.
    Otherwise, proceed to step 5.

    ### 4a. Early Exit

    On user abort: save agreement as-is, exit protocol, proceed to implementation.

    ### 5. Completion

    All items confirmed and user approved transition.
  </Protocol>
  <Constraints>
    | DO | DON'T |
    |----|-------|
    | Fill items autonomously before asking | Ask item-by-item like a form |
    | Commit to the best choice per unconfirmed sub-item, offer minimal + elegant alternatives | Leave unconfirmed items blank or offer alternatives per section |
    | Mark uncertain items as "unconfirmed" | Present guesses as confirmed facts |
    | Flag ambiguous items explicitly to the user | Assume the user noticed uncertainty |
    | Update agreement file on every change | Keep agreement only in conversation |
    | Respond to user's free requests mid-loop | Refuse non-structural requests |
    | Propose transition when all required items confirmed | Auto-transition without asking |
    | Respect user's "Continue discussion" choice | Push for transition prematurely |
    | Save and exit gracefully on user abort | Block early exit |
    | Stay in problem definition | Suggest implementation details or solutions |
    | Update items from organic conversation | Reject updates outside formal structure |
  </Constraints>
  <Output_Format>
    Agreement file at `.claude/coral/plans/pre-{topic}.md`:

    ```markdown
    # Pre-plan: {topic}

    ## Problem Statement
    - Current state: ...
    - Desired state: ... [unconfirmed]
      - default: X
      - minimal: Y
      - elegant: Z

    ## Success Criteria
    - [ ] Criterion 1
    - [ ] Criterion 2 [unconfirmed]
      - default: ...
      - minimal: ...
      - elegant: ...
    - [ ] Criterion 3 [unconfirmed]  <!-- needs verification, no alternatives -->

    ## Scope
    ...
    ## Assumptions
    ...
    ## Affected Systems
    ...
    <!-- remaining sections use the same sub-item pattern -->

    ## Constraints
    [If applicable, else N/A]

    ## Approach Direction
    [If applicable, else N/A]

    ## Additional Context
    [Conversation findings that don't fit the structured items above.
    e.g. user preferences, tangential observations, rejected alternatives and why.]
    ```

    Markers: only `[unconfirmed]` is marked — no marker means confirmed. Unconfirmed sub-items that need a decision list three alternatives as nested items (default, minimal, elegant). Unconfirmed sub-items that need verification have no nested list. Section headings carry no markers. Optional items need no markers.

    ### Transition Handoff

    User approved transition via AskUserQuestion in step 3.
    Finalize `.claude/coral/plans/pre-{topic}.md`, then: `Skill({ skill: "coral:plan", args: "{topic} [selected flags]" })`
    Do NOT pass `--no-handoff` — preplan has no post-plan step, so plan owns the implementation handoff.
  </Output_Format>
</Preplan_Protocol>
