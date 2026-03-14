# Statusline Right Alignment Breaks Across Resize Boundaries
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
Do not rely on space-padded right alignment in the Claude Code statusline even if `tput cols` works in the hook process. The statusline only re-renders on conversation turns, and lines that exceed the current terminal width are dropped, so width-dependent alignment is not stable across resizes.
## Why
This looks feasible in isolated testing because the hook can read the current TTY width and format a padded line correctly at that instant. The failure appears later: if the terminal narrows before the next conversation turn, Claude Code keeps the old padded text and silently drops overflowed second or third lines. That turns a cosmetic alignment tweak into missing status content.
## Pattern
Right:
```javascript
const line = `${left} ${right}`; // compact content that tolerates width changes
```

Wrong:
```javascript
const cols = Number(execSync("tput cols 2>/dev/tty").toString());
const padding = " ".repeat(Math.max(0, cols - left.length - right.length));
const line = `${left}${padding}${right}`;
```
