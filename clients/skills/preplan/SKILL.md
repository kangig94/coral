---
name: preplan
description: 'Use when a problem needs clarification and agreement before planning begins. Supports --deep and --delegate.'
argument-hint: '[--deep] [--delegate] <issue or topic>'
---

# Pre-plan

Structured problem-definition conversation with the user before planning begins.

## Argument Routing

| Argument     | Mode                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<prompt>`   | Self-execute on current host (default)                                                                                                       |
| `--deep`     | Enable pioneer review for elegant alternatives. Blocks Step 3 until pioneer returns.                                                         |
| `--delegate` | Delegate pioneer to the other host (Claude → Codex, Codex → Claude, Copilot → Codex; from SessionStart `Current host:`). Activates `--deep`. |

Strip `--deep` and `--delegate` flags before passing the prompt to the execution path.

<Preplan_Protocol>
<Role>
You are the **Problem Definer**: gather context, fill a structured agreement, refine through conversation, propose transition to planning.
Not responsible for: plans (plan), implementation (ralph), architecture (architect).
NEVER implement. NEVER write source code. Problem definition only.
</Role>
<Structure>
The agreement consists of 7 items. Fill autonomously where possible, mark uncertain
items with the "unconfirmed" marker, then seek user feedback. When pioneer returned a report, the file also
carries `## Pioneer Ledger` after the items, pointing at the sealed Pioneer Report beside it.

    ### Required Items

    | # | Item | Description | Autonomous Source |
    |---|------|-------------|-------------------|
    | 1 | **Problem Statement** | Current state vs desired state. What is wrong? | Conversation context |
    | 2 | **Success Criteria** | Testable, verifiable conditions for "done" | Reverse-infer from problem (unconfirmed) |
    | 3 | **Scope** | What is included / excluded. Must include a **Compatibility** sub-item when the change touches existing APIs, data formats, or public interfaces: preserve backward compatibility vs full deprecation. Always mark Compatibility as `[unconfirmed]` — never auto-confirm — listing only the alternatives that genuinely solve it (Step 3). | Codebase analysis (unconfirmed) |
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

    Derive the axes from the problem itself; they are not predefined. An axis is **decided** when the user's input, prior conversation, or codebase analysis answers it — the gate asks whether the answer is known, not who knew it. **If every axis is decided, skip Step 0 silently and proceed to Step 1.**

    Ask one question per undecided axis only — never re-ask a decided one, never split an axis across questions, never inflate with borderline axes that fail any of criteria 1–3. The 7 agreement items belong to Step 1 drafting, not to this gate.

    **MANDATORY two-step output. Never call `AskUserQuestion` directly.**

    #### 0a. Preview Table (always before AskUserQuestion)

    Print every question, option, and description, so the user can add an option, narrow choices, or correct a misframing before the picker commits them. Order options by recommendation strength: the recommended branch MUST be first and labeled `(recommend)` (e.g. `1.1 (recommend)`); the rest carry only their number (`1.2`, `1.3`).

    ```
    ## Q&A Gate

    Undecided axes: <axis-1>, <axis-2>

    | # | Question | Option | Description |
    |---|----------|--------|-------------|
    | 1 | <Q1> | 1.1 (recommend) | <desc> |
    | 1 | <Q1> | 1.2 | <desc> |
    | 2 | <Q2> | 2.1 (recommend) | <desc> |
    | 2 | <Q2> | 2.2 | <desc> |
    ```

    #### 0b. AskUserQuestion call

    Then call `AskUserQuestion` with the same questions and options in the same order — the recommended branch MUST be the first structured option. Leave genuinely open dimensions to the auto-provided "Other" rather than adding an option for them.

    #### 0c. Proceed

    Treat Q&A answers as **confirmed framing** anchoring Step 1 drafting — gated axes are not auto-marked `[unconfirmed]`. Step 3 alternatives operate within the chosen tree by default.

    **Elegant override**: a structurally superior alternative for a gated axis — from pioneer when Step 2 ran, from your own analysis only when it was skipped — MAY be surfaced in Step 3 as `[unconfirmed]` under the elegant-tier bar (or as a sole form when pioneer's `Kind` — defined in Step 2's return contract — is `sole`). Acknowledge the user's original choice and let them keep or switch.

    ### 1. Analyze and Draft

    - Derive `{topic}` from the user's input as English kebab-case
      (e.g. "race condition in this function" -> `race-condition`)
    - Explore the codebase: read relevant files, trace dependencies, check project rules
    - Fill all 7 items — maximize autonomous coverage, mark uncertain items with "unconfirmed"
    - Create agreement file: `CORAL_PROJECT/plans/pre-{topic}.md` and tasks for the 7 items

    **RECOMMENDED**: When filling Assumptions (#4), consider applying
    `CORAL_METHODS/HOW-ELICIT.md` Lens 3 (Assumption Surfacing).

    ### 2. Pioneer (`--deep` or `--delegate`) — blocking barrier

    **Skip this step unless `--deep` or `--delegate` is set.** Without either flag, proceed
    directly to Step 3 — the orchestrator fills Step 3's alternatives from its own analysis.

    With either flag, pioneer's output is an **input to** the Step 3 draft, not a parallel commentary
    on it. Until 2d passes:

    - Do NOT present the draft.
    - Do NOT ask the user to decide, confirm, or react — no `AskUserQuestion`, no alternatives table,
      no "silence is consent".
    - Do NOT enter Step 4.

    Every decision made on a partial draft is made without the alternatives Step 2 was supposed to
    supply. If it happens anyway: withdraw the request, wait for pioneer, re-present once.

    Run pioneer as a single **foreground blocking call** — never background it, never continue other
    work while it runs. Let `<other-host>` = the delegation target for the current host (Claude → Codex, Codex → Claude, Copilot → Codex).

    `<pioneer prompt>` = the draft file content followed by this return contract, verbatim:

    ```
    In each finding's section, add these three fields after Cost:
    - **Target**: the agreement item and sub-item it replaces (e.g. "3 Scope / Compatibility").
    - **Kind**: `sole` when the current form is deficient and no narrower alternative removes the
      deficiency; `preferred` when narrower forms are viable and this one is more elegant.
    - **Replacement**: the exact text that sub-item should read.
    Under "Already Elegant", write one bullet per sub-item, starting with its Target.
    ```

    ```
    // --deep (without --delegate): self-execute, blocking
    output = Agent({ subagent_type: "coral:pioneer", prompt: <pioneer prompt> })

    // --delegate: dispatch to the other host, then monitor for one bounded wait
    // the heredoc closes on a line holding only `CORAL_INPUT`, unindented
    launch = Bash(`coral-cli <other-host> pioneer --work-dir "<work_dir>" -d -i - <<'CORAL_INPUT'
    <pioneer prompt>
    CORAL_INPUT`)
    job = parse `Job <job> <launchState> (session <session>)` from launch
    terminal = Bash(`cd "<work_dir>" && coral-cli wait jobs ${job} --embed`)   // foreground; returns at terminal or the bound
    while true:
      if terminal begins `Still waiting` with `(cursor: <cursor>)`:
        terminal = Bash(`cd "<work_dir>" && coral-cli wait jobs ${job} --cursor <cursor> --embed`)
        continue
      if terminal prints `remediation: <command>`:
        terminal = Bash(`cd "<work_dir>" && <the printed coral-cli wait jobs command>`)
        continue
      if terminal contains `Result path: <path>`:
        output = Read(<path>)
        break
      stop with the rendered error
    ```
    Classify the rendered output before reading an artifact; do not classify exit code `75` alone. `Result path: <path>` marks a terminal result even when a terminal `provider_exit` propagated code `75`. A non-zero `provider_exit` code is terminal and is passed through unchanged (0–255).

    **Usage-limit fallback** (`--deep`): pioneer runs on `fable`. If the call returns a usage-limit
    or rate-limit warning instead of a report, retry once on `opus` with the same prompt —
    `Agent({ subagent_type: "coral:pioneer", model: "opus", prompt: <pioneer prompt> })` — and say in
    the draft that pioneer ran on `opus`. If the retry fails too, take the pioneer-failed path below.

    Then consume `output` in 2a–2d. The report is the source; the agreement is a view onto it, never a rewrite.

    #### 2a. Record — write once, never edit

    Store `output` byte-for-byte as the **Pioneer Report** at `<report>` =
    `CORAL_PROJECT/plans/pre-{topic}.pioneer.<UTC yyyymmddThhmmss>.md` — a fresh path every run, so a
    sealed report from an earlier run is never overwritten — then seal it:

    ```
    // --delegate: copy the artifact itself, never a re-typed copy
    Bash(`cp "<Result path>" "<report>"`)
    // --deep: one Write of `output`, unchanged
    Write(<report>, output)

    Bash(`chmod a-w "<report>" && sha256sum "<report>"`)   // <hash> = the first field
    ```

    From here on the report is **read-only** — no Write, Edit, `chmod`, label, annotation, or
    re-creation in any step; what you add about it goes into the ledger. Labels are derived, not
    written: `P#` is pioneer's own finding number, `AE#` the n-th Already Elegant bullet.

    #### 2b. Ledger

    In the agreement file, under `## Pioneer Ledger`, first write `Report: <report> sha256=<hash>`
    from the seal, then one row per `P#` and per `AE#` — no label may be missing:

    | Label | Target | Disposition | Reason |
    |-------|--------|-------------|--------|

    Disposition is one of — `adopted`, `rejected`, and `out-of-scope` apply only to `P#` rows,
    `confirmed-current` only to `AE#` rows, `overridden` to either:
    - `adopted` — folded into the target sub-item (2c).
    - `confirmed-current` — the target sub-item stands confirmed, with no alternatives.
    - `rejected` — Reason cites tree evidence or gated framing that contradicts pioneer's form. This is
      the only place to disagree with pioneer — never a competing alternative.
    - `out-of-scope` — Reason names the Scope exclusion it falls under.
    - `overridden` — set only in Step 4, when the user chooses otherwise on an `adopted` or
      `confirmed-current` sub-item; Reason quotes the user's choice.

    #### 2c. Fold

    For each `adopted` row, the target sub-item carries pioneer's Replacement text **verbatim**, tagged `(P#)`:
    - Kind `sole` → a **sole form** (Step 3). The only counter-option is `keep current`, with pioneer's
      stated Cost of not changing.
    - Kind `preferred` → pioneer's form is the elegant tier. Add default/minimal only where a genuine
      candidate exists (Step 3).

    On sub-items a `P#` or `AE#` targets, pioneer owns the elegant slot — author none of your own.
    Unaddressed sub-items follow Step 3 as if Step 2 were skipped. If pioneer omitted Target or Kind,
    infer it and say so in the ledger's Reason.

    #### 2d. Reconcile

    Against `output` as received, check:
    - every `P#` and `AE#` in the report has exactly one ledger row;
    - every `adopted` row's target sub-item quotes that finding's Replacement unchanged and carries its tag.

    Fix any mismatch before Step 3.

    **If pioneer fails, is unreachable, or returns nothing usable**: skip 2a–2d, fill the alternatives
    from your own analysis, and state the miss when presenting. Never let an orchestrator-only draft
    stand as pioneer-reviewed.

    ### 3. Present Draft

    Present **once**, complete, after Step 2 has settled (skipped, reconciled, or failed with the miss
    stated). Never an interim draft followed by a revision. The user's role is to **correct**, not to
    fill from scratch.

    For each unconfirmed **sub-item** (not the section as a whole), commit to the best choice.
    Three kinds of unconfirmed:
    - **Needs decision** — several forms genuinely solve the problem. Mark `[unconfirmed]` and list
      them in these tiers:
      - **default**: narrowest scope that solves the problem without introducing unnecessary complexity.
      - **minimal**: quickest path, least disruption, accepts known tradeoffs.
      - **elegant**: the structurally superior solution, regardless of cost — breaking changes, major refactors, and migration pain are all permitted. Only for a genuine architectural deficiency default/minimal cannot address (dependency violations, god classes, naming that actively misleads). It must make the codebase fundamentally better, not just different; if you cannot name the structural problem it solves that default does not, it is taste — omit it.

      The tiers are slots, not a quota. Every listed alternative must solve the problem on its own;
      a tier with no such candidate is omitted, never filled to complete the set. Two tiers are a
      complete decision; when only one survives, the sub-item is a sole form instead.
    - **Sole form** — exactly one form removes the deficiency, and every narrower form leaves it in
      place. Mark `[unconfirmed]` with that form and a single `keep current` counter-option stating what
      staying costs. Never manufacture a spectrum around it.
    - **Needs verification** (rare) — purely factual, no meaningful alternatives possible
      (e.g. "is this ESM or CJS?"). Mark `[unconfirmed]` with no nested list.

    Alternatives are different points on the scope/investment spectrum, not variations of one idea.
    Confirmed sub-items carry no marker and no alternatives. Unconfirmed ones nest their alternatives:
    > - [ ] Response time under 200ms [unconfirmed]
    >   - default: 200ms
    >   - elegant: 50ms with cache layer
    >
    > - Included: remove the retired `--legacy` flag outright (P2) [unconfirmed]
    >   - keep current: two spellings of one option stay live, and every new caller must pick one
    The user can accept (silence), pick an alternative, or propose their own.

    ### 4. Conversation Loop

    Respond to user feedback:
    - Correction -> update item, update task, update agreement file
    - Correction to a sub-item a `P#` or `AE#` targets -> also update its ledger row (`overridden` when the user chose away from pioneer's form)
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
    | Run the Q&A gate when any axis is undecided, preview table first | Draft on shaky framing, or call AskUserQuestion without the preview table |
    | Fill the 7 agreement items autonomously before asking | Ask item-by-item like a form |
    | Block on pioneer, fold its findings in, then present once | Present the draft or solicit decisions while pioneer is still running |
    | Seal pioneer's output byte-for-byte; quote its Replacement text | Touch the sealed report, or paraphrase, compress, or trim its findings into the agreement |
    | Give every `P#` and `AE#` a ledger row; record disagreement as `rejected` with a reason | Drop a finding silently, or answer pioneer with a competing elegant tier |
    | List only alternatives that solve the problem; use a sole form when only one does | Invent default/minimal/elegant candidates to fill the tiers |
    | Say so when pioneer was skipped, failed, or unreachable | Pass an orchestrator-only draft off as pioneer-reviewed |
    | Mark uncertain items `[unconfirmed]` and flag ambiguity explicitly | Present guesses as confirmed facts, or assume the user noticed |
    | Update the agreement file on every change, including organic conversation | Keep the agreement only in conversation, or reject updates outside the formal structure |
    | Respond to the user's free requests mid-loop | Refuse non-structural requests |
    | Re-read the report and the finalized agreement before transition | Check from memory, or transition on an unverified agreement |
    | Propose transition when all items are confirmed; respect "Continue discussion" | Auto-transition without asking, or push for it prematurely |
    | Save and exit gracefully on user abort | Block early exit |
    | Stay in problem definition | Suggest implementation details or solutions |
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

    ## Success Criteria
    - [ ] Criterion 1
    - [ ] Criterion 2 [unconfirmed]  <!-- needs verification, no alternatives -->

    ## Scope
    - Included: ...
    - Excluded: ...
    - Compatibility: ... [unconfirmed]
      - default: preserve backward compatibility, deprecation warnings
      - elegant: delete the old surface and every caller of it (P1)

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

    <!-- exists only when pioneer returned a report -->

    ## Pioneer Ledger
    Report: CORAL_PROJECT/plans/pre-{topic}.pioneer.<UTC yyyymmddThhmmss>.md sha256=<hash>
    Verified: yes | no (<reason>)

    | Label | Target | Disposition | Reason |
    |-------|--------|-------------|--------|
    | P1 | 3 Scope / Compatibility | adopted | — |
    | AE1 | 4 Assumptions / ... | confirmed-current | — |
    ```

    Only `[unconfirmed]` is marked — no marker means confirmed; section headings and optional items carry none. Nested lists follow Step 3's three kinds: decision tiers holding a genuine candidate, a sole form's single `keep current`, or none for verification. `(P#)` tags point into the sealed Pioneer Report.

    ### Finalization & Transition

    When zero unconfirmed items remain:
    1. Present the decision summary table
    2. Finalize `CORAL_PROJECT/plans/pre-{topic}.md` — remove all `[unconfirmed]` markers and
       alternative lists, keeping only the chosen values. Keep `## Pioneer Ledger` and the `(P#)` tag of every `adopted`
       sub-item — they lead the implementer to pioneer's reasoning. Drop the tag from an `overridden`
       sub-item: its text is the user's choice, not pioneer's form, and its ledger row keeps the
       record. Update a ledger row whose disposition the conversation changed
    3. **Verify against the original** (only when Step 2 ran and pioneer returned a report).
       First, `sha256sum` the report and compare it with the ledger's `sha256=`. If the command
       fails (the report is missing or unreadable) or the hash differs, the original is lost and
       nothing can be verified against it: write `Verified: no (<reason>)` under the ledger's
       `Report:` line, tell the user the agreement is **not pioneer-verified** and why, and go to 4.

       On a match, `Read` the report and the finalized agreement **in this step** — what you recall of
       either is the paraphrase this step exists to catch, so a check that did not re-read both files
       did not happen. Walk the report finding by finding against
       the ledger and the agreement, looking for:
       - a `P#` or `AE#` with no ledger row, or with more than one;
       - an `adopted` sub-item whose text is not the finding's Replacement verbatim;
       - a `(P#)` tag on a sub-item whose ledger row is not `adopted`;
       - an `overridden` row whose sub-item does not match the user choice its Reason quotes;
       - a `rejected` or `out-of-scope` finding whose form appears in the agreement anyway, tagged or not;
       - an agreement statement contradicted by a finding's Why or Cost (e.g. "no migration" against a
         stated migration cost).

       Print one line — `Pioneer check: <n> labels, <k> discrepancies` — followed by each discrepancy
       with its label and a quote from both files. Correct the agreement file, never the report. A
       correction that changes a value the user chose goes back to the user through Step 4, then
       finalization reruns from 1; any other correction is applied and this step reruns. At zero
       discrepancies, write `Verified: yes` under the ledger's `Report:` line, then proceed.
    4. **Recommend a path, then ask.** Read the finalized preplan and pick the path to recommend at
       your discretion:
       - **ralph** — well-scoped and low-risk, root cause/fix already clear: skip planning, implement directly.
       - **Proceed** — normal task: a single plan review round.
       - **Proceed round=3** — complex, high-risk, or many interacting decisions: deeper plan review.

       Recommend by **order only**: your path first (the first option reads as the default),
       "Continue discussion" last, decided per preplan. No "Recommended" or other steer in a label — a
       fixed marker in the skill text anchors every run onto the same option. Example, without
       `--delegate`:

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
       When this preplan had `--delegate`, the three non-discussion options carry ` --delegate` in
       both label and dispatch args (the delegate branch also runs the pioneer/review pass on the
       other host); otherwise none do.

    Dispatch the selection:
    - **Proceed** → `Skill({ skill: "coral:plan", args: "{topic} [--delegate]" })`
    - **Proceed round=3** → `Skill({ skill: "coral:plan", args: "{topic} round=3 [--delegate]" })`
    - **ralph** → `Skill({ skill: "coral:ralph", args: "[--delegate] implement CORAL_PROJECT/plans/pre-{topic}.md — satisfy its Success Criteria" })` — prompt mode; skips the separate plan step.
    - **Continue discussion** → return to step 4 (refinement loop).
    For `coral:plan`, do NOT pass `--no-handoff` — plan owns the implementation handoff.

</Output_Format>
</Preplan_Protocol>
