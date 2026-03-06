# Statusline ANSI Reset Stale Dimming
## Rule
When dimming a statusline segment that already contains ANSI formatting, reapply `DIM` after embedded `RESET` codes or thread stale rendering into the lower-level formatter; an outer `${DIM}...${RESET}` wrapper by itself is not enough.
## Why
Helpers that color percentages or timestamps often end those spans with `\x1b[0m`, which clears any outer dim state mid-string. In `coral-hud`, stale limit output contains nested color and dim spans, so naive whole-string dimming makes only part of the stale segment render dim while later pieces silently fall back to normal intensity.
## Pattern
Right:
```javascript
return `${DIM}${formatted.replaceAll(RESET, `${RESET}${DIM}`)}${RESET}`;
```

Wrong:
```javascript
return `${DIM}${formatted}${RESET}`;
```
