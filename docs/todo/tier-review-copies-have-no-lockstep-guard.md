# TODO — the two tier-review protocols are kept identical by hand

**Status**: open, measured 2026-09-29. One divergence has shipped; the guard shape is half-decided
elsewhere in the repository and the remaining decision is small.

## What is unguarded

`.claude/skills/tier-review/SKILL.md` is the protocol this repository reviews itself with.
`clients/skills/init-project/templates/skills/tier-review/SKILL.md` is the copy `init-project` writes into
every project it initializes. Measured 2026-09-29 they are byte-identical, and nothing asserts that: `grep`
over `tests/` finds no file naming the template path.

The history is one window, not a pattern, and the window is what makes the class real. Both files descend
from a single ancestor, `skills/review/SKILL.md`, which `#100` renamed into the template path; `#165`
created the repository copy as a byte-identical copy of it. From there the two were equal at every commit
except one: `#200` added the sentence *"and add coral:architect to the list of agents with tier 1 by
default."* to the repository copy alone, and `#220` ("Release 0.7.3", 2026-05-27) applied that same sentence
to the template. `#200` is itself the 0.6.0 release commit, so the drift shipped in seven releases —
0.6.0 through 0.7.2 — with the repository reviewing itself under a rule no project initialized in that
window had, until a release commit closed it. Nothing failed while it was open. (No version tag lies in the
window, so `git tag --contains` will not show it; the version bumps in `package.json` will.)

The repair that prompted this entry shows the procedure is unchanged: the Phase 4 severity rule was applied
twice, by hand, with `cmp` afterwards as the only check. That produced no drift — which is the point. The
process offers no reason it would not, and none of the times it did not are recorded either.

Reproducing the above needs `git log --follow` run **once per path**, and even then the output misleads in
two ways. `#265` moved the template under `clients/`, so a plain `git log -- <path>` stops at that move and
makes the template look untouched before it. And copy detection puts the shared pre-fork ancestor — `#88`,
`#89`, `#100` — into *both* `--follow` outputs, where it reads as one-sided editing of two files that did
not both exist yet. Checking what each commit did, rather than which log it appeared in, is what
distinguishes the single real divergence from that noise.

## Why it is not simply closed

Byte equality is the obvious guard and is probably the wrong one, and the repository has already said so
somewhere else. `clients/skills/init-project/SKILL.md` § Execution_Discipline rule 2 defines the relation —
read the template, copy it, graft only project-specific hooks — and rule 4 asks that a generated artifact
"contains every section and directive its template has — a structural diff, not a frontmatter-key existence
check". Note what that rule argues against: a check *weaker* than structural containment, not a stronger
one. Byte equality satisfies it. The sentence that anticipates divergence is rule 2's "graft only
project-specific hooks", and it is about a project's copy.

What that leaves undecided is narrower: whether *this* repository's copy is allowed to carry grafts. Today
it carries none, and the only graft it ever carried (`#200`'s architect sentence) was folded back into the
template rather than kept. That is evidence the intent here has been identity, but it is evidence, not a
decision, and a byte-equality test written on the strength of it would be discovered as an obstacle by
whoever first has a legitimate reason to diverge — the worst moment to discover it, and the one where the
likely response is to delete the test.

## What closing it requires

Decide whether this repository's copy may carry grafts. If it may not, byte equality is sufficient and its
failure message should name which file leads — today the repository's copy leads and the template is
mirrored from it by hand. If it may, the guard is the structural parity `init-project` rule 4 already
describes: compare the sections and directives, not the bytes, with the template leading.

Either way it is a cross-artifact check and belongs in `tests/invariants/`, beside
`client-path-parity.test.ts`, which already asserts that a `clients/` artifact matches its source.
[`invariant-path-literals-go-stale-silently.md`](./invariant-path-literals-go-stale-silently.md) is the
neighbouring entry and the contrast is the useful part: the guard it describes matched a literal by
equality against live paths and went silent when its subject moved, whereas a parity guard *reads* both
files, so a move like `#265` makes it throw. The shared concept is only that a guard did not move with what
it guards; this one will say so out loud.
