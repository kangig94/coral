# TODO — decide and expose the CLI jobs-output contract

**Status**: open. Split from PR #309 after the UX review found a product-contract decision rather than a
local table-formatting defect.

## The problem

`coral-cli jobs` renders the `SLOT` column only when at least one row occupies a workflow slot
(`src/cli/format/jobs.ts:273`). Each project section makes that decision independently
(`src/cli/format/jobs.ts:304,308,318`), so one invocation can contain both four- and five-column tables.

A script expecting `JOB ID / PHASE / PROVIDER / AGE` begins reading the slot label as `PHASE` as soon as a
workflow child appears. The command neither declares its table human-only nor offers a structured output
mode. The HTTP `/jobs` response is already structured; the gap is specifically the CLI surface.

## Decision required

Choose one of two explicit contracts:

1. **Stable tabular contract.** Fix the column schema for the command, including empty slot cells, and treat
   headers/order/arity as compatibility surface. Add fixtures proving multiple project sections cannot choose
   different arities.
2. **Human-only table plus structured mode.** Document the existing table as presentation, not a parsing
   contract, and add a separately named structured mode whose records are schema-validated and stable for
   automation.

The second branch may preserve responsive human formatting without making whitespace a protocol, but the
mode name, encoding, versioning, and error behavior are product decisions that must be made explicitly.

## Why it is split

Adding structured output is a new user-facing CLI surface. Declaring the existing table stable would also
create a compatibility promise that the command does not currently make. Neither decision follows merely
from repairing the `SLOT` column, and the HTTP shape does not automatically settle CLI policy.

## Explicitly out of scope

This item does not change the `/jobs` HTTP response, pick JSON/JSONL or a flag name, redesign job identity, or
solve terminal-width wrapping. Width policy is tracked separately because even a stable five-column table can
still be unreadable at 80 columns.

## Start condition

Begin only after the CLI owner chooses which branch is the supported automation contract. The implementation
must then include command help/documentation and regression tests for mixed project sections, empty/non-empty
slots, and scripts consuming the selected stable surface.
