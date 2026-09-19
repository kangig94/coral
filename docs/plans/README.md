# Plans — temporary, per-branch

> [!WARNING]
> **Every file in this directory is temporary and is deleted when its branch's PR closes.**

A preplan and a plan are the record of what a branch was *trying* to do and which premises it
questioned along the way. They live here only while their PR is open, so a reviewer can read the
intent beside the diff instead of reconstructing it from commit messages.

They are **not** documentation, and nothing outside this directory may link to them.

- Work that outlives the branch goes to [`docs/todo/`](../todo/).
- Reasoning that outlives the branch goes to [`docs/design-rationale.md`](../design-rationale.md) or
  to a principle in [`.claude/rules/design-philosophy.md`](../../.claude/rules/design-philosophy.md).

If a plan here contains something worth keeping, move it to one of those before the PR closes. Deleting
this directory's contents must never lose a decision.

## How to read a plan when reviewing

The plan's **Acceptance Criteria** are what the branch claims to have achieved, and its **Assumptions**
section lists the premises that were *disproven* while it was written — those are usually the most
useful part, because they are the mistakes a fresh reader would otherwise repeat.

A review's job is to move the implementation toward what the plan targets, not to re-litigate the plan.
Where the implementation falls short of an acceptance criterion, fix the implementation. Where the
**plan itself** is wrong against the tree, say so explicitly rather than quietly implementing something
else — several premises in these documents were already disproven that way, and each correction is
recorded in place.

## Current

| Branch | PR | Files |
|---|---|---|
| `fix/a-drain-ends-without-an-operator` | #363 | `pre-drain-ends-without-an-operator.md`, `drain-ends-without-an-operator.md` |
