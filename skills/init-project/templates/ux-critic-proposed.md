# Proposed UX-Critic Enhancements

## Merge Instructions

These are proposed additions to `ux-critic.md`. Review each section.
Mark ✅ to accept, ❌ to reject, or ✏️ to modify before merging.

The existing `ux-critic.md` was crafted with BotW environmental teaching philosophy —
"the environment itself pulls users toward their goal" — and must not be disrupted.
Each proposed section below preserves and extends this language.

---

## Proposed: Stage Calibration (add after audience calibration paragraph)

```
Calibrate evaluation depth based on development stage:
- Prototype/MVP → focus on Navigation (no dead-ends) and Transitions (error states exist).
  Tolerate rough visual gravity and undeveloped discovery paths.
- Iteration → all dimensions active. Primary focus: Cognitive Clarity and Visual Gravity.
- Polish → all dimensions at maximum scrutiny. Discovery hooks and seamless transitions
  are the difference between good and exceptional.
```

---

## Proposed: Expanded Anchor Descriptions (replace existing 1-liners in step 7)

Preserve the BotW-inspired language. Each level gets 3-5 behavioral indicators.

**Cognitive Clarity** (10): the interface teaches without instruction
  - Zero jargon without context; every label self-evident to target audience
  - User decisions for primary task ≤2; information structured to reduce working memory
  - The environment itself guides understanding — no instructions needed
  - Content organized so the right next step feels inevitable
(7): ≤3 decisions; minor labels need context for target user
(4): needs explicit instructions to complete primary task; jargon unexplained
(1): unusable without external help or documentation

**Visual Gravity** (10): primary action unmistakably pulls attention
  - Primary action is the most visually prominent element
  - Emphasis adapts to user context (new vs returning, empty vs populated)
  - Different personas encounter appropriate visual hierarchy
(7): prominent + major contexts handled; one context shows wrong emphasis
(4): competes with secondary elements; hierarchy doesn't adapt to state
(1): no discernible hierarchy; reader cannot identify what to do next

**Navigation** (10): every state has clear goal + attractive alternatives
  - Main goal is leading from every reachable state
  - 1-2 attractive alternatives visible alongside (not buried)
  - Spatial arrangement guides — this is a composition, not a flat list
(7): no dead-ends; alternatives require 1 scroll to discover
(4): some dead-end states; alternatives require significant hunting
(1): users get stuck — no forward path from reachable states

**Transitions** (10): all state changes feel seamless and physical
  - Loading → content, error → recovery, empty → populated all natural
  - Visual boundaries through spacing and shape, not just borders
  - Error states are forks in the road, not walls
(7): major transitions smooth; one minor jarring change
(4): some jarring state changes; error states feel like walls
(1): disorienting transitions; user loses context on state change

**Discovery** (10): complexity reveals itself through curiosity hooks
  - Complexity layered with intentional curiosity hooks — users WANT to discover more
  - Intriguing preview text, contextual hints, progressive onboarding
  - Disclosure points create hooks that intrigue, not just hide
(7): layered but passive — findable if sought, not actively discovered
(4): features hidden without discovery path; advanced features invisible
(1): feature dump on initial load OR features buried with no path at all

---

## Proposed: Assessment Checklists (new section after Investigation_Protocol step 6)

```xml
<Assessment_Checklist>
  Cognitive Clarity:
  - [ ] Primary task completable in ≤3 decisions
  - [ ] No jargon without surrounding context
  - [ ] Information structured (lists, steps, groups) not dumped (wall of text)
  - [ ] Labels describe outcome, not mechanism

  Visual Gravity:
  - [ ] Primary action is the most visually prominent element
  - [ ] Different user contexts (new vs returning, empty vs populated) have appropriate emphasis
  - [ ] No competing visual weights for primary action

  Navigation:
  - [ ] Every reachable state has a clear forward path toward the main goal
  - [ ] 1-2 attractive alternatives visible alongside primary path
  - [ ] No dead-end states (including error states)

  Transitions:
  - [ ] Loading, error, empty states all exist
  - [ ] State changes feel natural (no jarring jumps)
  - [ ] Error states are forks in the road, not walls

  Discovery:
  - [ ] Complexity layered with intentional curiosity hooks
  - [ ] Hidden features have discovery paths (not just buried)
  - [ ] Progressive disclosure intrigues rather than merely hides
</Assessment_Checklist>
```

---

## Proposed: Common UX Anti-Patterns (new section)

```xml
<Common_Anti_Patterns>
  | Anti-Pattern | Dimension | Indicator |
  |---|---|---|
  | Mystery meat navigation | Navigation | Unlabeled icons with no tooltip or context |
  | Feature dump | Discovery | All features visible on first screen with equal weight |
  | Dead-end state | Navigation | Error page or empty state with no forward path |
  | False floor | Discovery | User thinks they've seen everything; features hidden below fold |
  | Modal abuse | Transitions | Modal dialogs for non-blocking information |
  | Zombie empty state | Transitions | Empty list with no guidance on how to populate it |
  | Context amnesia | Gravity | User returns and UI forgets their previous state/context |
  | One-size-fits-all | Gravity | Same layout for admin vs viewer, empty vs populated state |
</Common_Anti_Patterns>
```

---

## Proposed: Quality Level Mapping (new section before Output_Format)

```xml
<Quality_Levels>
  | Composite | Level | Meaning | Action |
  |-----------|-------|---------|--------|
  | 9-10 | Exceptional | The interface teaches through environment alone — users discover by doing | PASS with commendation |
  | 7-8 | Strong | Natural flow with minor polish opportunities | PASS |
  | 5-6 | Adequate | Functional but the environment doesn't pull users toward their goals | PASS with STRONG findings |
  | 3-4 | Needs Work | Significant dead-ends, confusion, or missing states | NEEDS WORK |
  | 1-2 | Reject | Interface requires external instruction to use | NEEDS WORK (suggest redesign) |
</Quality_Levels>
```

---

## Proposed: Strengths + Priority Recommendations (Output_Format additions)

After UX Score table, before Findings:

```
### Strengths
- {What the UX does well — minimum 2 specific observations with file:line}
  (Identify where the interface successfully teaches through environment)

### Priority Recommendations
| # | Impact | Dimension | Recommendation |
|---|--------|-----------|----------------|
| 1 | HIGH/MEDIUM | {dimension} | {specific actionable improvement} |
```

Change verdict line from:
`### Verdict: PASS / NEEDS WORK`

To:
`### Verdict: {Quality Level} — PASS / NEEDS WORK`

---

## Proposed: Platform-Specific Considerations (new section)

```xml
<Platform_Specific_Considerations>
  Evaluation priority adjusts based on platform context.
  "Primary focus" means spend extra scrutiny — not a mathematical weight.

  **Web Application**:
  - Primary focus: Visual Gravity — screen real estate allows rich hierarchy
  - Primary focus: Navigation — browser back/forward must integrate naturally
  - Additional check: responsive breakpoints don't break hierarchy
  - Additional check: keyboard navigation for all interactive elements

  **Mobile App**:
  - Primary focus: Cognitive Clarity — small screen demands minimal decisions
  - Primary focus: Transitions — gesture-based navigation must feel physical
  - Additional check: thumb-zone accessibility for primary actions
  - Additional check: offline/degraded state handling

  **Browser Extension / Plugin**:
  - Primary focus: Discovery — limited surface area demands curiosity hooks
  - Primary focus: Cognitive Clarity — popup/sidebar context is constrained
  - Additional check: host page integration doesn't confuse boundaries
  - Additional check: first-use experience in constrained context

  **CLI Tool**:
  - Primary focus: Cognitive Clarity — help text and error messages are the entire UX
  - Primary focus: Navigation — command discovery through help, completions, suggestions
  - Additional check: error messages include recovery commands
  - Additional check: progressive disclosure through subcommands/flags
</Platform_Specific_Considerations>
```
