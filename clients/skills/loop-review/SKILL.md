---
name: loop-review
description: 'Use after implementation to review and fix tier by tier — each code tier loops until it reports no BLOCKING — then run one final tier-review. Supports --delegate.'
argument-hint: '[--delegate] [scope]'
---

# Loop Review

Review, fix, and re-review one tier at a time until each code tier is clean, then close with one
non-looping tier-review.

## Argument Routing

| Argument     | Mode                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `[scope]`    | Reviewers and fixer run on `<run-host>` = the current host when it is a provider (`claude`, `codex`); on Copilot, `codex`             |
| `--delegate` | `<run-host>` = the other host (Claude → Codex, Codex → Claude, Copilot → Codex; current host comes from SessionStart `Current host:`) |

Strip `--delegate` before using the rest as the scope.

<Loop_Review_Protocol>
<Role>
You are the loop controller. You launch reviewers, read their verdicts, hand BLOCKING findings to
a fixer, commit each fix, and decide the next step strictly by the rules below.
You do not review and you do not fix. A verdict you did not read from a reviewer's result file
does not exist.
</Role>
<Constraints>
| DO | DON'T |
|----|-------|
| Advance only on a parsed verdict of `blocking=0` for every reviewer of the tier | Advance on your own reading of a review, a partial verdict set, or an unparsable one |
| Stop on a stop signal and report it | Keep patching past a stop signal, or hold waiting for a person |
| Pass findings to the fixer verbatim | Summarize, merge, or re-rank findings in the fix brief |
| Commit each round's fix with exactly the paths the fixer changed | `git add -A`, or stage a path that was already dirty before the run and the fixer did not touch |
| Keep reviewers read-only; the fixer is the only writer | Run a fixer while reviewers of the same round are still running |
| Update the state file after every step | Keep loop state only in conversation |
</Constraints>
<Protocol>

### 1. Setup

1. **Scope**: the argument if given; otherwise every path changed on this branch against the
   default branch, plus uncommitted changes.
2. **Baseline**: record `git status --porcelain`. Paths dirty here are the user's; the fixer's
   commits never stage one it did not change.
3. **Agents**: read `.claude/rules/agents.md` — the Quick Reference (agent, tier) and the
   Consultation Matrix. Add `coral:architect` at tier 1. A documentation reviewer (e.g.
   `doc-critic`) is the `doc` tier whatever its row says. Without `agents.md`, read
   `.claude/agents/*.md` and take each tier from its description or Situation table; when unclear,
   safety reviewers are tier 1, domain reviewers tier 2, quality reviewers tier 3. Mark each agent
   INVOKE when the matrix or its Situation table matches the scope, SKIP otherwise. No agents at
   all → report and stop.
4. **State file**: create `CORAL_PROJECT/loop-review/<UTC yyyymmddThhmmss>.json` and keep it
   current:

   ```json
   {
     "scope": "...",
     "runHost": "codex",
     "baselineDirty": ["..."],
     "tier": 1,
     "rounds": [
       {
         "tier": 1,
         "round": 1,
         "reviews": [{ "agent": "...", "job": "...", "blocking": 0 }],
         "blocking": 0,
         "fixCommit": null
       }
     ],
     "stop": null,
     "finalReview": null
   }
   ```

   - `tier` is `1`, `2`, `3`, or `"doc"` — the same type wherever it appears.
   - A review's `blocking` is a number or `"unknown"`; a round's `blocking` is the sum over its
     reviews once none is `"unknown"`.
   - `fixCommit` is the round's fix commit sha, or `null` when the round made none.
   - `stop` becomes `{ "tier": ..., "signal": ..., "detail": ... }`.
   - `finalReview` becomes `{ "verdict": ..., "findings": [...] }` after Step 4.

Print the invocation plan (tier, agent, INVOKE/SKIP) before the first round.

### 2. Tier loop — tiers 1, 2, 3 in order

Skip a tier with no INVOKE agent. For each round `r` of tier `T`:

**2a. Review.** Launch every INVOKE agent of tier `T` in parallel, each with
`<review prompt>` = the scope, that agent's focus, and this verdict contract appended verbatim:

```
End your report with this block and nothing after it:
- one line per BLOCKING finding: `BLOCKING <path>:<line> — <finding>`. BLOCKING means your own
  scale's must-fix-before-merge level (BLOCKING, CRITICAL, or HIGH); list nothing below it here.
- then exactly one line: `LOOP-VERDICT: blocking=<n>`, where <n> is the number of BLOCKING lines.
Review is read-only. NEVER run `git checkout`, `git switch`, `git stash`, `git reset`,
`git restore`, or `git clean`, and never stage or commit — you share this working tree with
parallel reviewers. To inspect another revision, use `git diff <ref>`, `git show <ref>:<path>`,
or `git log <ref>` — never check it out.
```

```
launch = Bash(`coral-cli <run-host> <agent> -i "<review prompt>" --work-dir "<project root>" -d`)   // one per agent
jobs = parse every `Job <job> <launchState> (session <session>)` line
terminal = Bash(`cd "<project root>" && coral-cli wait jobs <job-id...> --embed`)
while jobs remain:
  if terminal begins `Still waiting` with `(cursor: <cursor>)`:
    terminal = Bash(`cd "<project root>" && coral-cli wait jobs <job-id...> --cursor <cursor> --embed`)
    continue
  if terminal prints `remediation: <command>`:
    terminal = Bash(`cd "<project root>" && <the printed coral-cli wait jobs command>`)
    continue
  for each block with `Result path: <path>`: result[job] = Read(<path>); mark job done
  if a terminal block names live siblings (`Run coral-cli wait jobs <ids> to continue waiting.`):
    terminal = Bash(`cd "<project root>" && coral-cli wait jobs <job-id...> --embed`)   // those ids
    continue
  if jobs remain: stop with signal `error`, detail = the rendered output
```

Classify the rendered output, not exit code `75` alone: `Result path: <path>` marks a terminal
result even when a terminal `provider_exit` propagated code `75`. A non-zero `provider_exit` code
is terminal and is passed through unchanged (0–255).

**2b. Verdict.** For each result, take the last non-empty line. It must be
`LOOP-VERDICT: blocking=<n>` and `<n>` must equal the number of `BLOCKING ` lines; otherwise the
verdict is `"unknown"`. Relaunch an `unknown` reviewer once in the same round. Still `unknown` →
stop with signal `verdict-unavailable`. Unknown is never read as clean.

**2c. Pass.** Every reviewer `blocking=0` → tier `T` is done; go to the next tier.

**2d. Stop signals** — checked in this order before any fix; the first that holds stops the run:

| Signal      | Holds when                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mirror`    | Rounds `r` and `r − 1` are both mirror rounds. Round `k` is a mirror round when every BLOCKING `<path>:<line>` of round `k` lies inside a hunk of round `k − 1`'s `fixCommit` (`git show <fixCommit> --unified=0`) — so it can first hold at `r` = 3 |
| `stalled`   | Rounds `r` and `r − 1` are both stalled rounds. Round `k` is stalled when round `k − 1`'s `fixCommit` added more lines than it removed and round `k`'s `blocking` (the sum) is not lower than round `k − 1`'s — so it can first hold at `r` = 3      |
| `round-cap` | `r` = 8                                                                                                                                                                                                                                              |

A stop — including `verdict-unavailable`, `no-fix`, and `error` — is a result, not a failure to
hide: record it, skip every remaining loop, and go to Step 4. `mirror` and `stalled` mean further patches move the defect instead of ending it — the
report escalates them as a design question.

**2e. Fix.** Launch one fixer with `<fix brief>` = every BLOCKING line of the round verbatim,
grouped by reviewer, followed by:

```
Fix exactly these findings. Change nothing else.
When a finding's remedy is comparative (retain or delete, more or less, bounded or unbounded),
name both failure modes and fix without creating the opposite one; if they conflict, report the
conflict instead of choosing silently.
Never run git checkout, switch, stash, reset, restore, or clean, and never stage or commit.
Do not run lint, build, or tests.
```

```
launch = Bash(`coral-cli <run-host> -b -i "<fix brief>" --work-dir "<project root>" -d`)
job = parse `Job <job> <launchState> (session <session>)` from launch
terminal = Bash(`cd "<project root>" && coral-cli wait jobs <job> --embed`)
while true:
  if terminal begins `Still waiting` with `(cursor: <cursor>)`:
    terminal = Bash(`cd "<project root>" && coral-cli wait jobs <job> --cursor <cursor> --embed`)
    continue
  if terminal prints `remediation: <command>`:
    terminal = Bash(`cd "<project root>" && <the printed coral-cli wait jobs command>`)
    continue
  if terminal contains `Result path: <path>`: break
  stop with signal `error`, detail = the rendered output
```

**2f. Commit.** Read the fixer's `Result path` for any conflict it reported; carry it into the
report. Then `changed` = the paths in `git status --porcelain` now, minus `baselineDirty`. Empty
`changed` → stop with signal `no-fix`. Otherwise stage exactly `changed` (`git add -- <changed>`)
and commit `fix: loop-review tier <T> round <r>` with the round's BLOCKING lines in the body,
following the project's commit convention. Record `fixCommit`, then start round `r + 1`.

### 3. Doc tier — once

Launch the INVOKE doc-tier agents as in 2a–2b and record them as round 1 of tier `"doc"`. If any
reports BLOCKING, run one fixer (2e) and commit (2f) with `<T>` = `doc`. No re-review.

### 4. Final review — once

Invoke `Skill(tier-review)` once over the whole scope when the project has it; otherwise launch
every INVOKE agent of every tier once as in 2a–2b. Do not loop and do not fix: record its
verdict and findings in `finalReview`, and they go into the report as the run's closing state.

### 5. Report

Set `stop` in the state file if not already set, then print the report and end.
</Protocol>
<Output_Format>

## Loop Review: {scope}

| Tier | Rounds | BLOCKING per round | Outcome          |
| ---- | ------ | ------------------ | ---------------- |
| 1    | 3      | 4 → 1 → 0          | clean            |
| 2    | 2      | 2 → 2              | stopped: stalled |
| 3    | —      | —                  | not reached      |
| doc  | 1      | 1                  | fixed once       |

### Commits

| Tier / round | Commit | Findings fixed |
| ------------ | ------ | -------------- |

### Stop

{signal and detail — for `mirror` or `stalled`, the findings that kept moving, stated as the
design question to escalate — or "none"}

### Final tier-review

{its verdict and every remaining finding, verbatim}

State: `CORAL_PROJECT/loop-review/<run>.json`
</Output_Format>
</Loop_Review_Protocol>
