# Discuss: Inject Codebase Briefing Before Discussion

## Rule
Add a codebase scan + current state briefing phase between topic analysis and persona generation in the discuss skill. Inject the briefing into each discussant's prompt listing: already-solved items (with brief implementation details), known open gaps, and key architecture decisions already made. Include an explicit instruction: "DO NOT propose solutions for already-solved items."

## Why
AI discussants without implementation context waste turns re-proposing already-solved problems. In a 10-speech discussion on "Coral의 미래", 3 of 5 failure modes cited and the core architectural proposal were already implemented — the developer identified this immediately. Discussion becomes unproductive when agents rediscover existing design rather than focusing on genuinely unresolved questions.

## Pattern
```markdown
# WRONG — no briefing
# Discussants receive: topic + persona
# Result: agents propose solutions already in the codebase

# RIGHT — briefing phase before persona generation
## Briefing to inject into each discussant prompt:
**Implemented:**
- Session persistence via atomic writes (session-manager.ts)
- k-DPP persona sampling (persona-seed.ts)
- ...

**Open gaps:**
- No cross-session analytics
- Discuss history not exported
- ...

**Key decisions:**
- Direct `codex({ op: "coral:<agent>" })` delegation for Codex-side agent routing
- ...

DO NOT propose solutions for already-implemented items above.
```

The briefing forces discussion toward the actual frontier rather than re-litigating settled design.
