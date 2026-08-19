# TODO — define one terminal-width policy for identity-rich CLI output

**Status**: open. Split from PR #309 after the UX review established that the new identity fields expose a
cross-command layout policy gap rather than one bad cell.

## The problem

Realistic identity rows exceed common terminal widths. A `jobs` row using the short label `critic` is already
about 86 characters; a maximum-length label is about 103. A workflow-detail replacement row reaches roughly
117 characters.

`formatTable` receives no terminal-width input, so an 80-column terminal wraps cells and destroys alignment.
List and detail therefore cannot respond to available width. Follow/wait does receive terminal width, but
`renderWaitLine` only pads (`src/cli/format/wait.ts`); it never bounds the identity label, so prompt labels
and terminal headers wrap as well.

## Decision required

Choose one responsive rendering policy and apply it consistently across jobs list, job/workflow detail, and
follow/wait:

- responsive columns with a deterministic priority for hiding or shortening fields;
- vertical records below a width threshold; or
- width-aware identity shortening with an unambiguous way to recover the full value.

The policy must cover ordinary rows and replacement rows rather than special-casing the newly added field.
Whichever shape is selected must preserve the distinction among job id, workflow slot label, generation, and
replacement identity.

## Required evidence

Regression fixtures must render at exactly 80 columns with UUID job ids, maximum-length labels, and
replacement rows. They must cover list, detail, and follow/wait so one surface cannot adopt a different
shortening rule. Wider-terminal fixtures should prove the responsive policy does not unnecessarily discard
information.

## Why it is split

This is a cross-cutting presentation policy affecting every table and the streaming follow renderer. A local
truncation in `jobs` would leave detail and wait wrapping differently and could erase the identity distinction
the current PR is adding.

## Explicitly out of scope

This item does not choose whether `coral-cli jobs` is an automation contract, add structured output, rename
identity fields, or change backend response schemas. It also does not prescribe ANSI-aware measurement or a
specific truncation glyph until the rendering policy is chosen.

## Start condition

Begin after one policy is selected for all three surfaces and its information-priority rules are written down.
The implementation must have a shared width input at each renderer boundary and the 80-column assertions
above before changing individual cells.
