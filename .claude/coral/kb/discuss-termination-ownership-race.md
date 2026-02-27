# Discuss _7_end Termination Ownership Race

## Rule
Only the main context (team-lead) should call `_7_end`. The discuss-lead agent must report convergence via `SendMessage` to the team-lead, not call `_7_end` directly. If both call `_7_end`, duplicate synthesis is written. Add either (1) an explicit constraint in the discuss-lead agent prompt prohibiting `_7_end` usage, or (2) an `already_ended` guard in the `_7_end` handler that returns an error if the session is already ended.

## Why
The discuss-lead has full access to `_7_end` and calls it autonomously when it detects convergence. The main context also calls `_7_end` as the stated termination owner. Both succeed, producing duplicate synthesis entries. The root cause is that the discuss-lead spawn prompt does not constrain `_7_end` usage.

## Pattern
```
# Wrong: discuss-lead calls _7_end on convergence detection
discuss-lead detects convergence → calls _7_end with synthesis → main context also calls _7_end → duplicate

# Right: discuss-lead reports, main context terminates
discuss-lead detects convergence → SendMessage to team-lead → team-lead calls _7_end once
```
