---
name: preplan
description: "Use when a problem needs clarification and agreement before planning begins. Supports --deep and --delegate."
argument-hint: "[--deep] [--delegate] <issue or topic>"
---

# Pre-plan

Structured problem-definition conversation with the user before planning begins.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Self-execute on current host (default) |
| `--deep` | Enable pioneer review for elegant alternatives |
| `--delegate` | Delegate pioneer to the other host (Codex when current is Claude, Claude when current is Codex; from SessionStart `Current host:`). Activates `--deep`. |

Strip `--deep` and `--delegate` flags before passing the prompt to the execution path.

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
    | 3 | **Scope** | What is included / excluded. Must include a **Legacy** sub-item when the change touches existing APIs, data formats, or public interfaces: preserve backward compatibility vs full deprecation. Always mark Legacy as `[unconfirmed]` with default/minimal/elegant alternatives — never auto-confirm. | Codebase analysis (unconfirmed) |
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
    ### 0. Q&A Gate

    Before drafting, identify **gate axes** — decisions that satisfy all three criteria:

    1. **Orthogonal**: branches are distinct trees, not points on a spectrum (cannot be expressed as Step 3 default/minimal/elegant alternatives)
    2. **Implementation-divergent**: choosing differently means different code structure, not different parameter values
    3. **Late-cost**: changing the choice after drafting requires rewriting, not refining

    The orchestrator derives concrete axes from the problem itself — they are not predefined. **If every derived axis is decided, skip Step 0 silently and proceed to Step 1.**

    "Decided" — resolvable from the user's input, prior conversation context, or codebase analysis. The gate evaluates whether the answer is known, not who knew it.

    Q&A gate prepares questions **only for undecided axes** — decided axes are never re-asked. One question per derived axis. Do not split a single axis across multiple questions, do not inflate by including borderline axes that fail any of criteria 1–3. Do not use this gate to fill the 7 agreement items — those belong in Step 1 drafting.

    **MANDATORY two-step output. Never call `AskUserQuestion` directly.**

    #### 0a. Preview Table (always before AskUserQuestion)

    Print a markdown table that enumerates every question, every option, and the option's description. The user audits framing scope here — they may add an option, narrow choices, or correct a misframing before the picker UI commits them.

    Schema:

    ```
    ## Q&A Gate

    Undecided axes: <axis-1>, <axis-2>

    | # | Question | Option | Description |
    |---|----------|--------|-------------|
    | 1 | <Q1> | 1.1 | <desc> |
    | 1 | <Q1> | 1.2 | <desc> |
    | 2 | <Q2> | 2.1 | <desc> |
    | 2 | <Q2> | 2.2 | <desc> |
    ```

    #### 0b. AskUserQuestion call

    After printing the table, call `AskUserQuestion` with the same questions and options. Discrete branches use structured options; for genuinely open dimensions, leave free-form input to the auto-provided "Other" choice rather than adding an explicit option for it.

    #### 0c. Proceed

    Treat Q&A answers as **confirmed framing** anchoring Step 1 drafting — gated axes are not auto-marked `[unconfirmed]`. Step 3 alternatives operate within the chosen tree by default.

    **Elegant override**: if a structurally superior alternative for a gated axis is identified (typically by Step 2 pioneer; rarely by the orchestrator's own analysis), it MAY be surfaced in Step 3 as `[unconfirmed]` under the same elegant-tier bar — genuine architectural deficiency, not taste. Acknowledge the user's original choice and let them keep or switch.

    ### 1. Analyze and Draft

    - Derive `{topic}` from the user's input as English kebab-case
      (e.g. "race condition in this function" -> `race-condition`)
    - Explore the codebase: read relevant files, trace dependencies, check project rules
    - Fill all 7 items — maximize autonomous coverage, mark uncertain items with "unconfirmed"
    - Create agreement file: `CORAL_PROJECT/plans/pre-{topic}.md` and tasks for the 7 items

    **RECOMMENDED**: When filling Assumptions (#4), consider applying
    `CORAL_METHODS/HOW-ELICIT.md` Lens 3 (Assumption Surfacing).

    ### 2. Pioneer (`--deep` or `--delegate`)

    **Skip this step unless `--deep` or `--delegate` is set.** Without either flag, proceed
    directly to Step 3 — the orchestrator fills the three-point spectrum from its own analysis.

    Dispatch pioneer to find the most elegant alternatives. Let `<other-host>` = Codex if current host is Claude; Claude if current host is Codex.

    ```
    // --deep (without --delegate): self-execute
    output = Agent({ subagent_type: "coral:pioneer", prompt: <draft file content> })

    // --delegate: dispatch to the other host
    launch = Bash(`coral-cli <other-host> pioneer -i "<draft file content>" --work-dir "<work_dir>" -d`)
    job = parse `Job <job> <launchState> (session <session>)` from launch
    terminal = Bash(`coral-cli wait --jobs "${job}" --embed`)
    output = Read(<path from the terminal's `Result path:` line>)
    ```

    For items where pioneer identifies a genuinely more elegant form: mark the sub-item
    unconfirmed and add the three-point spectrum (default, minimal, elegant).

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
    (e.g. "3 unconfirmed items remaining"). When zero remain, proceed to **Finalization & Transition**
    in `<Output_Format>`.
    If the user continues discussion and items are re-modified, re-present when zero remain again.

    ### 4a. Early Exit

    On user abort: save agreement as-is, exit protocol, proceed to implementation.

    ### 5. Completion

    All items confirmed and user approved transition.
  </Protocol>
  <Constraints>
    | DO | DON'T |
    |----|-------|
    | Run Q&A gate when any axis fails the gate-criteria check | Skip gate and draft on shaky framing |
    | Print Q&A preview table before AskUserQuestion | Call AskUserQuestion directly without preview table |
    | Fill the 7 agreement items autonomously before asking | Ask item-by-item like a form |
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
    Agreement file at `CORAL_PROJECT/plans/pre-{topic}.md`:

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
    - Included: ...
    - Excluded: ...
    - Legacy: ... [unconfirmed]
      - default: preserve backward compatibility, deprecation warnings
      - minimal: break immediately, no migration path
      - elegant: versioned migration with adapter layer

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

    ### Finalization & Transition

    When zero unconfirmed items remain:
    1. Present the decision summary table
    2. Finalize `CORAL_PROJECT/plans/pre-{topic}.md` — remove all `[unconfirmed]` markers and
       alternative lists, keeping only the chosen values
    3. **Recommend a path, then ask.** Branch the options on whether *this preplan* was invoked
       with `--delegate`: when it was, every Proceed/ralph option carries ` --delegate` in both its
       label and its dispatch args (the delegate branch also runs the pioneer/review pass on the
       other host); when it wasn't, none do. Read the finalized preplan and pick the path to
       recommend at your discretion:
       - **ralph** — well-scoped and low-risk, root cause/fix already clear: skip planning, implement directly.
       - **Proceed** — normal task: a single plan review round.
       - **Proceed round=3** — complex, high-risk, or many interacting decisions: deeper plan review.

       Surface the recommendation by **order only** — list your chosen path first (the first option
       reads as the default); keep "Continue discussion" last. Do NOT put "Recommended" (or any
       other steer) in a label — a fixed marker in the skill text anchors every run onto the same
       option. Decide the order per preplan. Example option set, preplan invoked **without** `--delegate`:

    ```
    AskUserQuestion({ questions: [
      { question: "Preplan finalized. How should we proceed?", header: "Next",
        options: [
          { label: "Proceed", description: "Plan with a single review round" },
          { label: "Proceed round=3", description: "Plan with 3 review rounds (complex/high-risk)" },
          { label: "ralph", description: "Skip planning — implement the finalized preplan directly" },
          { label: "Continue discussion", description: "Keep refining the preplan" }
        ], multiSelect: false }
    ]})
    ```
       With `--delegate`, the first three labels read `Proceed --delegate`, `Proceed round=3 --delegate`,
       `ralph --delegate`.

    Dispatch the selection (append `--delegate` to the args only when this preplan had it):
    - **Proceed** → `Skill({ skill: "coral:plan", args: "{topic} [--delegate]" })`
    - **Proceed round=3** → `Skill({ skill: "coral:plan", args: "{topic} round=3 [--delegate]" })`
    - **ralph** → `Skill({ skill: "coral:ralph", args: "[--delegate] implement CORAL_PROJECT/plans/pre-{topic}.md — satisfy its Success Criteria" })` — prompt mode; skips the separate plan step.
    - **Continue discussion** → return to step 4 (refinement loop).
    For `coral:plan`, do NOT pass `--no-handoff` — plan owns the implementation handoff.
  </Output_Format>
</Preplan_Protocol>
