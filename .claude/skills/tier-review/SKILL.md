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

    Tiers 1–3 review code; the **doc tier** reviews documentation. By default every tier runs at
    once. Under `--gated` the doc tier runs last, after the In scope code findings are fixed.
    This lets documentation reviewers check the code that will ship.
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

    1. Use the caller-supplied scope, or the diff (staged + unstaged) if none was supplied.
    2. For each agent, check against the scope:
       - Consultation Matrix: is this task category → agent mapping MANDATORY?
       - Agent's Situation/Priority table: does the scope match?
    3. Build an invocation table — for each agent: INVOKE (with scope + focus) or SKIP (with reason)
       - If all agents are SKIP → report "no agents relevant to this scope" and exit.
    4. Report the table before executing.

    ## Phase 3 — Execute

    Spawn only agents marked INVOKE in the table.
    Pass the same Phase 2 scope to every reviewer, with the focus from its invocation plan.
    Include `Finding_Tier_Rules` from Phase 4 and request the three findings sections in
    `Output_Format`.

    **Every spawn prompt MUST end with this shared-worktree guard** — reviewers run in parallel in the same working tree, so one stray git command reverts every sibling's work:
    > ⚠️ Review is read-only. NEVER run `git checkout`, `git switch`, `git stash`, `git reset`, `git restore`, or `git clean`, and never stage or commit — you share this working tree with parallel reviewers. To inspect another revision, use `git diff <ref>`, `git show <ref>:<path>`, or `git log <ref>` — never check it out.

    **Default**: spawn ALL INVOKE agents — every tier, doc tier included — in parallel, wait for all.

    **With `--gated`** (cost-saving short-circuit — use when API budget is tight):
    1. Tier 1 (safety) — spawn in parallel, wait for all to complete
       - Apply Phase 4 to the reports received so far. If any In scope finding is BLOCKING,
         report the consolidated findings and REJECT verdict, mark the doc tier `DEFERRED`,
         and stop here.
    2. Tier 2 (domain) + tier 3 (quality) — spawn in parallel, wait for all to complete
    3. Apply Phase 4 to the code findings from steps 1–2 and fix the In scope findings. Then
       spawn the doc tier in parallel and wait for all, so it reviews the code as fixed.
       Record how each In scope code finding was fixed.

    ## Phase 4 — Consolidate

    Finding tiers are independent of agent tiers. Use the Phase 2 scope to classify unlayered
    findings and check reported tiers.

    <Finding_Tier_Rules>
      | DO | DON'T |
      |----|-------|
      | Classify each real defect before assigning severity. Use the caller's review scope, or the diff if no scope was passed. | Let severity decide the tier. |
      | Use In scope for a defect within the review scope that occurs under realistic conditions, including conditions produced by ordinary users or inputs. Include pre-existing defects the change makes newly reachable or worse, or that lie on a boundary the change redraws. | Treat untouched code or docs as automatically Out of scope. |
      | Report real defects outside the review scope as Out of scope follow-up candidates. State why each is out of scope. | Expand the review scope to act on follow-up candidates. |
      | Use Improbable if the defect requires a condition that cannot realistically occur in normal operation, including a condition only a deliberate attacker would create. Name the condition, explain why it is unrealistic, and mark attacker-creatable yes if an attacker could create it or no otherwise. | Use Improbable when you cannot name the required condition. Put that finding In scope. |
      | Assign severity in every tier. Use only In scope findings to score the reviewed work and decide the verdict under the existing floor rules. | Let Out of scope or Improbable findings change a score or verdict. |
    </Finding_Tier_Rules>

    Apply merge rules to all agent results:
    1. **Dedup**: Merge reports of the same defect into one entry and list all agents.
    2. **Finding tier**: If reviewers disagree on a finding's tier, keep the stricter tier
       (In scope > Out of scope > Improbable).
    3. **A verdict never lowers a finding.** For findings consolidated as In scope, only the
       agent's label can make the finding BLOCKING. Apply a verdict floor only to an agent's
       *unlabelled* reports of those findings: `PASS` → MINOR; `FAIL`, `NEEDS WORK`, and the
       `NO VERDICT` recorded for an INVOKED agent whose report carries none → STRONG.
       A `PASS` beside the agent's own In scope labelled BLOCKING finding contradicts itself.
       Carry the BLOCKING and name the contradiction in that agent's `Key Findings` cell.
       An agent reaching `NEEDS WORK` from its own score floor with nothing above MINOR does
       not move the run verdict on its own.
    4. **Severity**: If reviewers disagree, use the higher severity. Carry labels outside the
       verdict table's scale verbatim and say where this rule could not order them. If an Out
       of scope or Improbable finding has no reported label, assign a severity from its
       evidence and indicate that it was assigned during consolidation.
    5. **Convergent signals**: Same file flagged by multiple agents → elevate priority within its
       finding tier.
    6. **Root cause**: A finding from an agent in tier 1 that explains a symptom from an agent in
       tier 3 → connect and elevate priority within the findings' tiers.

    Issue the final verdict using only In scope findings. Base the high-quality check for
    EXCEPTIONAL on the reviewed scope.

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
    | {1/2/3/doc} | {agent} | INVOKED/SKIPPED/DEFERRED | PASS/NEEDS WORK/FAIL/NO VERDICT/- | {summary, skip reason, or deferral reason} |

    ### Strengths
    - {Positive observations from agents with file:line evidence}

    ### Consolidated Findings

    #### In scope

    | # | Severity | Agent(s) | Location | Finding | Suggestion |
    |---|----------|----------|----------|---------|------------|
    | 1 | BLOCKING/STRONG/MINOR | {sources} | file:line | {issue} | {fix} |

    #### Out of scope

    | # | Severity | Agent(s) | Location | Finding | Suggestion | Why out of scope |
    |---|----------|----------|----------|---------|------------|------------------|
    | 1 | BLOCKING/STRONG/MINOR | {sources} | file:line | {issue} | {fix} | {scope rationale} |

    #### Improbable

    | # | Severity | Agent(s) | Location | Finding | Suggestion | Required condition — why unrealistic — attacker-creatable yes/no |
    |---|----------|----------|----------|---------|------------|------------------------------------------------------------------|
    | 1 | BLOCKING/STRONG/MINOR | {sources} | file:line | {issue} | {fix} | {required condition — why unrealistic — attacker-creatable yes/no} |

    ### Verdict: [EXCEPTIONAL / APPROVED / APPROVED WITH CONDITIONS / NEEDS WORK / REJECT]
    {justification}
  </Output_Format>
</Review_Protocol>
