# Statusline Regression Intended Diff Baseline
## Rule
When a statusline change intentionally alters specific output bytes, define verification as "existing behavior plus named exceptions" instead of demanding exact output parity across the entire line.
## Why
Regression checks become self-contradictory when the plan both requires exact matching and requests explicit rendering changes. In the HUD UX plan, session cost text and NBSP trailing-space protection are intended differences; treating them as generic regressions makes the acceptance criteria impossible to satisfy cleanly and obscures real unintended drift.
## Pattern
Right:
```text
Preserve current success-path rendering except:
- session slot may prepend cost
- trailing padding spaces are converted to NBSP before write
```

Wrong:
```text
Output must match the previous rendering exactly.
```
