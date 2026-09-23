---
name: tier-review
description: "Use after implementation to run tier-classified review agents and produce a consolidated verdict."
argument-hint: "[--gated] [scope description]"
---

# Review Gate

Run project review agents by tier taxonomy, consolidate findings, issue a verdict.

<Review_Protocol>
  <Role>
    You are the review gate executor. Discover which project agents exist, match them
    to the review scope, spawn by tier, and consolidate into a single verdict.

    Tiers 1–3 review code; the **doc tier** reviews documentation and runs apart from them, last.
    Docs describe the code, so they are reviewed only once the code tiers have nothing BLOCKING —
    a doc reviewed against code that is still changing is reviewed against the wrong thing.
  </Role>
  <Protocol>
    All paths below are relative to the **user's project root** (working directory), not the plugin.

    ## Phase 1 — Discover Agents

    1. Read the project's `.claude/rules/agents.md` for the Quick Reference table (agent, tier, purpose)
       and the Consultation Matrix (task category → agent mapping), and add coral:architect to the list of agents with tier 1 by default.
    2. If agents.md not found, read `.claude/agents/*.md` — look for tier in description
       or Situation table. If tier is unclear, treat safety-related agents as tier 1,
       domain-specific as tier 2, quality reviewers as tier 3, documentation reviewers as the doc tier.
    3. Any agent whose subject is documentation (e.g. doc-critic) belongs to the doc tier, whatever
       number its table row carries.
    4. If no agents found at all → report "no review agents configured" and exit.

    ## Phase 2 — Plan

    1. Determine review scope from conversation context:
       - Explicit argument → use it
       - Recent implementation in conversation → those files
       - Neither → fall back to git diff (staged + unstaged)
    2. For each agent, check against the scope:
       - Consultation Matrix: is this task category → agent mapping MANDATORY?
       - Agent's Situation/Priority table: does the scope match?
    3. Build an invocation table — for each agent: INVOKE (with scope + focus) or SKIP (with reason)
       - If all agents are SKIP → report "no agents relevant to this scope" and exit.
    4. Report the table before executing.

    ## Phase 3 — Execute

    Spawn only agents marked INVOKE in the table, in two stages.
    For each agent, pass: "Review [scope files] focusing on [focus from plan]."

    **Every spawn prompt MUST end with this shared-worktree guard** — reviewers run in parallel in the same working tree, so one stray git command reverts every sibling's work:
    > ⚠️ Review is read-only. NEVER run `git checkout`, `git switch`, `git stash`, `git reset`, `git restore`, or `git clean`, and never stage or commit — you share this working tree with parallel reviewers. To inspect another revision, use `git diff <ref>`, `git show <ref>:<path>`, or `git log <ref>` — never check it out.

    **Stage 1 — code tiers (1–3).**
    - **Default**: spawn all INVOKE code-tier agents in parallel, wait for all.
    - **With `--gated`** (cost-saving short-circuit — use when API budget is tight):
      1. Tier 1 (safety) — spawn in parallel, wait for all to complete
         - If ANY returns BLOCKING findings → output REJECT verdict, STOP here
      2. Tier 2 (domain) + tier 3 (quality) — spawn in parallel, wait for all to complete

    **Stage 2 — doc tier.** Runs only after Stage 1 has completed with no BLOCKING finding, and
    never in parallel with it. Spawn the INVOKE doc-tier agents in parallel, wait for all.
    If Stage 1 has any BLOCKING finding, do not spawn the doc tier: mark its agents `DEFERRED`
    ("code tiers not yet passing") and issue the verdict from Stage 1 alone. The doc tier runs on
    the next invocation, once the code passes.

    ## Phase 4 — Consolidate

    Apply merge rules to all agent results:
    1. **Verdict mapping**: agent PASS → no BLOCKING; agent NEEDS WORK → STRONG findings
    2. **Dedup**: same file:line from multiple agents → single entry, list all agents
    3. **Severity**: agents disagree → use higher severity
    4. **Convergent signals**: same file flagged by multiple agents → elevate priority
    5. **Root cause**: tier 1 finding that explains tier 3 symptom → connect and elevate

    Issue final verdict:
    | Condition | Verdict |
    |-----------|---------|
    | Any BLOCKING finding | REJECT |
    | Multiple unresolved STRONG findings | NEEDS WORK |
    | No BLOCKING, 1-2 STRONG items remaining | APPROVED WITH CONDITIONS |
    | No BLOCKING, no unresolved STRONG | APPROVED |
    | No BLOCKING, no STRONG, all agents report high quality | EXCEPTIONAL |
  </Protocol>
  <Output_Format>
    ## Review: [scope]

    | Tier | Agent | Status | Verdict | Key Findings |
    |------|-------|--------|---------|--------------|
    | {1/2/3/doc} | {agent} | INVOKED/SKIPPED/DEFERRED | PASS/FAIL/- | {summary, skip reason, or deferral reason} |

    ### Strengths
    - {Positive observations from agents with file:line evidence}

    ### Consolidated Findings
    | # | Severity | Agent(s) | Location | Finding | Suggestion |
    |---|----------|----------|----------|---------|------------|
    | 1 | BLOCKING/STRONG/MINOR | {sources} | file:line | {issue} | {fix} |

    ### Verdict: [EXCEPTIONAL / APPROVED / APPROVED WITH CONDITIONS / NEEDS WORK / REJECT]
    {justification}
  </Output_Format>
</Review_Protocol>
