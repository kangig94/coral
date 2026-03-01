# Integrity Baselines Must Use SHA256, Not HEAD

## Rule
When a plan includes an "file is unchanged from pre-plan state" acceptance criterion,
capture a SHA256 fingerprint at plan start and compare against that recorded value
during verification. Never use `git show HEAD:<file>` — HEAD reflects the last commit,
not the working-tree baseline, so pre-existing uncommitted edits or prior branch state
differences silently break the guarantee.

## Why
`git show HEAD:<file>` compares against the most recent commit, which may differ from
the working-tree state when the plan was written. If the file was edited before the last
commit, or if the branch has commits ahead of origin, the comparison is against the
wrong baseline. SHA256 is deterministic and captures exactly the byte state at the
moment of capture.

## Pattern
**Wrong** (verification step):
```bash
git show HEAD:skills/init-project/templates/ux-critic.md | sha256sum
# Compares against last commit, not pre-plan baseline
```

**Right** (capture at plan start):
```bash
sha256sum skills/init-project/templates/ux-critic.md
# Record the output: e2353626... path
```

**Right** (verification step):
```bash
sha256sum skills/init-project/templates/ux-critic.md
# Compare against the recorded baseline value
```

**Context**: discovered during `scholar-eval-diamond-extraction.md` where AC16 required
ux-critic.md to be byte-identical to pre-plan state. The plan's original verification
step 8 used HEAD comparison, which was identified by adversarial review as fragile.
