# Bash grep Pipe Returns Exit 1 When First grep Finds Nothing

## Rule
When verifying absence with a piped grep (`grep A | grep -v B`), the outer grep exits 1
if it finds nothing — causing the inner grep -v to also exit 1 on empty input.
Use `|| echo "(PASS: none)"` after the outer grep, or use `-c` count comparison instead.

## Why
`grep -n "Synthesizer" file | grep -v "resolver"` is meant to check "no bare Synthesizer remains."
But when `file` has no Synthesizer at all (desired result), the first grep exits 1, the pipe
propagates exit code 1, and bash reports a failure even though the verification passed.
This caused a false "error detected" hook trigger during verification runs.

## Pattern
**Wrong** (exits 1 when the desired answer is "none found"):
```bash
grep -n "Synthesizer" SKILL.md | grep -v "resolver"
```

**Right** (exits 0 when none found, which is the success case):
```bash
grep -n "Synthesizer" SKILL.md | grep -v "resolver" || echo "(PASS: none found)"
```

**Also right** (count-based, no pipe exit code issue):
```bash
count=$(grep -c "Synthesizer" SKILL.md)
[ "$count" -eq 0 ] && echo "PASS: 0 matches" || echo "FAIL: $count matches"
```

For "verify absence" checks in verification scripts, prefer `|| echo "(PASS)"` suffix
or count-based checks over raw piped greps.
