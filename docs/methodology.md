# Methodology System

Cross-cutting methodology files that define HOW agents perform specific reasoning tasks. Each HOW file is the single source of truth for its domain — agents reference them without duplicating content.

## Methodology Layer

Eight HOW files in `clients/methods/`, connected by two cross-references:

```
┌─────────────────────────────────────────────────────────────┐
│                    METHODOLOGY LAYER                        │
│                                                             │
│  ┌──────────────┐     ┌───────────────┐     ┌────────────┐  │
│  │ HOW-REVIEW   │     │ HOW-SYNTHESIZE│     │ HOW-RESOLVE│  │
│  │ (adversarial │     │ (Vada frame   │     │ (TRIZ      │  │
│  │  review +    │     │  feedback     │     │  conflict  │  │
│  │  taxonomy)   │     │  synthesis)   │     │  resolution│  │
│  └──────┬───────┘     └───────────────┘     └────────────┘  │
│         │                                                   │
│         │ ref:L21 "counterexample                           │
│         │          checklist"                               │
│         ▼                                                   │
│  ┌──────────────┐                                           │
│  │ HOW-COMPLETE │                                           │
│  │ (exit eval   │                                           │
│  │  criteria)   │                                           │
│  └──────────────┘                                           │
│                                                             │
│  ┌──────────────┐     ┌───────────────┐     ┌────────────┐  │
│  │HOW-PROVENANCE│───▶│HOW-CONFIDENCE │     │HOW-FALSIFY │  │
│  │ (evidence    │ref  │ (GRADE-based  │     │ (hypothesis│  │
│  │  source      │L21  │  confidence   │     │  eliminat.)│  │
│  │  chain)      │     │  grading)     │     │            │  │
│  └──────────────┘     └───────────────┘     └────────────┘  │
│                                                             │
│  ┌──────────────┐                                           │
│  │ HOW-ELICIT   │                                           │
│  │ (multi-lens  │                                           │
│  │  gap detect.)│                                           │
│  └──────────────┘                                           │
│                                                             │
│  ── = cross-reference (read-only dependency)                │
└─────────────────────────────────────────────────────────────┘
```

### HOW File Summary

| File | Domain | Origin | Standalone |
|------|--------|--------|------------|
| `HOW-REVIEW.md` | Adversarial review with counterexample checklist + reasoning failure taxonomy | Jalpa (adversarial debate from a role) | Yes |
| `HOW-SYNTHESIZE.md` | Multi-reviewer feedback synthesis (Adopt/Adapt/Defer/Diverge) | Vada (truth-seeking debate) | Yes |
| `HOW-RESOLVE.md` | Constraint Collision resolution via TRIZ inventive principles | Altshuller's TRIZ | Yes |
| `HOW-COMPLETE.md` | Review loop exit evaluation (frame stability, counterexample coverage) | — | No: references HOW-REVIEW counterexample checklist |
| `HOW-FALSIFY.md` | Competing hypothesis elimination via Vitanda (pure destruction) | Vitanda (debate to destroy, not establish) | Yes |
| `HOW-CONFIDENCE.md` | GRADE-based evidence confidence grading (4 tiers, 2-phase algorithm) | GRADE clinical framework | No: starting point determined by evidence type from HOW-PROVENANCE |
| `HOW-PROVENANCE.md` | Evidence source chain (claim → source → identifier → verification) | — | Yes |
| `HOW-ELICIT.md` | Multi-lens gap detection (Boundary + Deviation + Assumption + Inversion + Completeness) | HAZOP (ICI) + Pre-mortem (Klein) + ABP (RAND) + Gawande checklist + FMEA | Yes |

### Cross-References

| From | To | Purpose |
|------|----|---------|
| HOW-CONFIDENCE L21 | HOW-PROVENANCE | Starting point (HIGH/MODERATE/LOW/VERY LOW) is determined by evidence type |
| HOW-COMPLETE L21 | HOW-REVIEW | Exit evaluation references counterexample type checklist |

HOW-FALSIFY, HOW-SYNTHESIZE, HOW-RESOLVE, and HOW-ELICIT are standalone — no external dependencies.

## Agent Layer

Each agent owns one primary HOW methodology. Some read it unconditionally (MANDATORY), others only when `--deep` is passed (CONDITIONAL). Some have additional recommended connections.

```
┌──────────────────────────────────────────────────┐
│                         AGENT LAYER              │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────┐      │
│  │   architect      │  │    critic        │      │
│  │                  │  │                  │      │
│  │ ▒▒ HOW-REVIEW    │  │ ▒▒ HOW-REVIEW    │      │
│  │ ▒▒ HOW-PROVENANCE│  │ ▒▒ HOW-PROVENANCE│      │
│  └──────────────────┘  └──────────────────┘      │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │             resolver                     │    │
│  │                                          │    │
│  │ ██ HOW-SYNTHESIZE (Step 0, unconditional)│    │
│  │ ██ HOW-RESOLVE    (Step 3, on Constraint │    │
│  │                    Collision)            │    │
│  │ ▓▓ inline inference:                     │    │
│  │    provenance (reviewer evidence → type) │    │
│  │    confidence (reviewer agreement → tier)│    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌───────────────────────────────────┐           │
│  │             debugger              │           │
│  │                                   │           │
│  │ ██ HOW-FALSIFY    (2+ hypotheses) │           │
│  │ ██ HOW-CONFIDENCE (2+ hypotheses) │           │
│  │ ░░ HOW-PROVENANCE (on conclusion) │           │
│  │ ░░ HOW-CONFIDENCE (on conclusion) │           │
│  └───────────────────────────────────┘           │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │             scanner                        │  │
│  │                                            │  │
│  │ ██ HOW-FALSIFY (Process Investigation,     │  │
│  │                  2+ hypotheses)            │  │
│  │ ░░ HOW-PROVENANCE (when producing findings)│  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │             gap-finder                     │  │
│  │                                            │  │
│  │ ██ HOW-ELICIT  (before any gap analysis)   │  │
│  │ ░░ HOW-PROVENANCE (when producing findings)│  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│    ██ = MANDATORY    ▒▒ = --deep ONLY            │
│    ░░ = RECOMMENDED  ▓▓ = inline                 │
└──────────────────────────────────────────────────┘
```

### Method → Agent Connections

| HOW File | Agent | Strength | Trigger Condition |
|----------|-------|----------|-------------------|
| HOW-REVIEW | architect | `--deep` ONLY | When `--deep` is in prompt |
| HOW-REVIEW | critic | `--deep` ONLY | When `--deep` is in prompt |
| HOW-FALSIFY | debugger | MANDATORY | 2+ competing hypotheses |
| HOW-CONFIDENCE | debugger | MANDATORY | 2+ competing hypotheses |
| HOW-CONFIDENCE | debugger | RECOMMENDED | When concluding root cause analysis |
| HOW-PROVENANCE | debugger | RECOMMENDED | When concluding root cause analysis |
| HOW-PROVENANCE | architect | `--deep` ONLY | When `--deep` is in prompt |
| HOW-PROVENANCE | critic | `--deep` ONLY | When `--deep` is in prompt |
| HOW-FALSIFY | scanner | MANDATORY | Process Investigation + 2+ competing hypotheses |
| HOW-PROVENANCE | scanner | RECOMMENDED | When producing findings |
| HOW-SYNTHESIZE | resolver | MANDATORY | Step 0 (unconditional) |
| HOW-RESOLVE | resolver | MANDATORY | Step 3 (on Constraint Collision) |
| HOW-ELICIT | gap-finder | MANDATORY | Before any gap analysis |
| HOW-PROVENANCE | gap-finder | RECOMMENDED | When producing findings |

### Agent Inline Logic

Some agents apply methodology concepts without reading HOW files — context-specific application rules, not content duplication.

| Agent | Logic | Rationale |
|-------|-------|-----------|
| resolver | Provenance inference: reviewer evidence pattern → type label | Resolver already verifies reviewer file:line references; pattern matching yields provenance type directly |
| resolver | Confidence inference: reviewer agreement level → tier | Multiple reviewers citing same evidence → HIGH; single verified → MODERATE; unverified → LOW; assumption → VERY LOW |
| analyze skill | Provenance gate: tag surviving findings with evidence type, downgrade assumption-only | Orchestration checklist for post-processing, not methodology description |

### Debugger Dual-Path Design

The debugger has a unique dual-path structure ensuring confidence method coverage for both complex and simple diagnoses:

```
        debugger diagnosis start
              │
              ▼
       2+ hypotheses?
       ┌──────┴──────┐
       │ YES         │ NO
       ▼             ▼
┌────────────┐  ┌────────────┐
│ MANDATORY  │  │ single     │
│ path       │  │ hypothesis │
│            │  │ diagnosis  │
│ MUST read: │  │            │
│ HOW-FALSIFY│  │ (MANDATORY │
│ HOW-       │  │  does not  │
│ CONFIDENCE │  │  trigger)  │
└──────┬─────┘  └──────┬─────┘
       │               │
       ▼               ▼
┌────────────────────────────┐
│  on conclusion:            │
│                            │
│  RECOMMENDED:              │
│  HOW-PROVENANCE (tagging)  │
│  HOW-CONFIDENCE (grading)  │
└────────────────────────────┘
            │
            ▼
  Output: Confidence: HIGH/
  MODERATE/LOW/VERY LOW
```

MANDATORY forces reading for complex multi-hypothesis diagnoses. RECOMMENDED provides a lighter pointer for single-hypothesis cases, ensuring the debugger always has access to the confidence grading methodology.

### Ownership Pattern

Each agent owns one primary HOW methodology. An agent may own one additional conditional HOW that activates only when the primary protocol detects a specific trigger.

| Agent | Primary HOW | Conditional HOW | Trigger |
|-------|-------------|-----------------|---------|
| architect | HOW-REVIEW (`--deep`) | — | — |
| critic | HOW-REVIEW (`--deep`) | — | — |
| debugger | HOW-FALSIFY | HOW-CONFIDENCE | 2+ competing hypotheses |
| scanner | HOW-FALSIFY | — | Process Investigation + 2+ hypotheses |
| resolver | HOW-SYNTHESIZE | HOW-RESOLVE | Constraint Collision detected |
| gap-finder | HOW-ELICIT | — | — |

HOW files do not route to other HOW files — the caller selects the appropriate agent, and the agent knows which methodology to apply. This prevents mid-protocol methodology switching.

## Skill Layer

Skills orchestrate agents and read HOW files directly for protocol-level decisions.

```
┌────────────────────────────────────────────────────────────────────┐
│                          SKILL LAYER                               │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    plan skill                                │  │
│  │                                                              │  │
│  │  Phase 1 (--delegate)     Phase 2 (always)                   │  │
│  │  ┌──────────────────┐    ┌──────────────────┐                │  │
│  │  │ 4a: coral-cli    │    │ 4a: architect    │                │  │
│  │  │ codex architect  │    │     critic       │  ──parallel──  │  │
│  │  │ /critic -i       │    │                  │                │  │
│  │  └────────┬─────────┘    └────────┬─────────┘                │  │
│  │           │                       │                          │  │
│  │  ┌────────▼─────────┐    ┌────────▼─────────┐                │  │
│  │  │ 4b: coral-cli    │    │ 4b: resolver     │  --deep only   │  │
│  │  │ codex resolver   │    │  (edits plan)    │                │  │
│  │  │ -i               │    │                  │                │  │
│  │  └──────────────────┘    └──────────────────┘                │  │
│  │                                                              │  │
│  │  Step 5: Handoff → coral:ralph                               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   analyze skill                              │  │
│  │                                                              │  │
│  │  Step 1: scanner.md protocol ─────── → ## Scan Report        │  │
│  │  Step 2: gap-finder.md protocol ──── → ## Gap Analysis       │  │
│  │  Step 3: debugger.md protocol ────── → ## Root Cause         │  │
│  │                                                              │  │
│  │  Phase 3: Post-process gates (skill executes directly):      │  │
│  │    a. CRITICAL/HIGH reference verification                   │  │
│  │    b. Inclusion gate                                         │  │
│  │    c. Exclusion gate                                         │  │
│  │    d. Provenance gate — tag evidence type + downgrade        │  │
│  │    e. Move to Peripheral Findings                            │  │
│  │    f. Record finding flow with provenance distribution       │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### Method → Skill Connections

| HOW File | Skill | Strength | Trigger |
|----------|-------|----------|---------|
| (none) | plan | — | Resolver owns synthesis and exit decision; orchestrator does not read HOW files directly |
| (none) | analyze | — | Provenance gate executes inline without reading HOW files |
| (none) | preplan | — | References HOW-REVIEW conceptually (prose mention only) |
| HOW-ELICIT | preplan | RECOMMENDED | When filling Assumptions (#4) |

## End-to-End Workflow

How the layers connect in a typical planning workflow:

```
User request
    │
    ▼
┌──────────┐     ┌──────────┐
│ preplan  │───▶│  plan    │
│ (problem │     │ (design) │
│  define) │     └────┬─────┘
└──────────┘          │
      ┌───────────────┼───────────────┐
      │               │               │
      ▼               ▼               ▼
┌──────────┐   ┌──────────┐   ┌──────────┐
│architect │   │ critic   │   │ resolver │
│          │   │          │   │ (--deep) │
│▒▒REVIEW  │   │▒▒REVIEW  │   │██SYNTH.  │
│▒▒PROVEN. │   │▒▒PROVEN. │   │██RESOLVE │
└──────────┘   └──────────┘   │▓▓inline  │
      │               │       └────┬─────┘
      └───────┬───────┘            │
              │   feedback synth.  │
              ◀───────────────────┘
              │
              ▼
        ┌──────────┐
        │ plan 4e  │
        │▒▒COMPLETE│   iterate or exit (--deep)
        └────┬─────┘
             │ approved
             ▼
        ┌──────────┐
        │  ralph   │
        │ (execute)│
        └──────────┘
Independent workflow:
┌──────────┐
│ analyze  │
│          │
│ scanner ─┤
│ gap-find.┤
│ debugger ┤── ██FALSIFY + ██CONFIDENCE (2+ hypotheses)
│          │   ░░PROVENANCE + ░░CONFIDENCE (conclusion)
│ provenance gate (Phase 3)
└──────────┘
```

## Design Principles

### 1. Single Source of Truth

HOW files define methodology. Agents reference them without duplicating content. When an agent needs to know evidence types, it reads HOW-PROVENANCE — it does not contain an inline list of types. This prevents drift between agent descriptions and methodology definitions.

Exception: resolver's inline inference rules are context-specific application (mapping reviewer evidence patterns to provenance/confidence), not methodology duplication. The resolver does not reproduce HOW-PROVENANCE's verification chain or HOW-CONFIDENCE's grading algorithm — it applies simplified heuristics suited to its synthesis workflow.

### 2. Proportional Enforcement

Connection strength matches importance to the agent's core mission:

- **MANDATORY**: Essential for the agent's primary function. Without it, the agent cannot perform its mission correctly. Example: debugger cannot eliminate hypotheses without HOW-FALSIFY.
- **`--deep` ONLY**: Read only when `--deep` flag is passed in the prompt. Enables deeper methodology-driven analysis at the cost of additional context. Example: architect reads HOW-REVIEW only in `--deep` mode; otherwise uses built-in protocol.
- **RECOMMENDED**: Improves output quality but is not required for basic function. Example: debugger can produce findings without provenance tags, but tagged findings are more trustworthy.
- **Conditional MANDATORY**: Same as MANDATORY, but only triggers under specific conditions. Example: debugger reads HOW-FALSIFY and HOW-CONFIDENCE only when 2+ competing hypotheses exist — simple single-hypothesis diagnoses do not pay the context cost.

### 3. No HOW-to-HOW Routing

HOW files never direct agents to other HOW files. Each agent's prompt defines which HOW files to read and under what conditions. This prevents mid-protocol methodology switching, which LLMs handle poorly — an agent following one methodology should not be told to switch to another mid-execution.

The two cross-references (HOW-CONFIDENCE → HOW-PROVENANCE, HOW-COMPLETE → HOW-REVIEW) are data dependencies (one file's content depends on definitions in another), not routing directives.
