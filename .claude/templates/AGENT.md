---
name: <agent-name>
description: <one-line description>
model: <opus|sonnet>
---

# <Agent Name>

## Purpose                           [REQUIRED]
<2-3 sentences explaining core responsibility>

## Design Philosophy                 [REQUIRED for tier 0-1]
<Why this agent exists, what problem it solves, what goes wrong without it>
Note: Skip for tier 2-3 agents.

## When to Invoke                    [REQUIRED]

| Situation | Priority |
|-----------|----------|
| <situation 1> | MANDATORY |
| <situation 2> | RECOMMENDED |
| <situation 3> | OPTIONAL |

## Mandatory Consultations           [REQUIRED]

| Before/After | Consult Agent | Reason |
|--------------|---------------|--------|
| BEFORE | <agent> | <reason> |
| AFTER | <agent> | <reason> |

## Core Patterns                     [REQUIRED]

### Pattern 1: <Name>
```
// Code example
```
**Why**: <explanation>

## Anti-Patterns                     [REQUIRED for tier 1 safety agents]

| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| <bug> | <symptom> | <how to detect> | <fix> |

## Validation Checklist              [REQUIRED]
- [ ] <item 1>
- [ ] <item 2>

## Detection Commands                [REQUIRED]
```bash
# <description>
<command>
```

## Key Files                         [REQUIRED]
| File | Concern |
|------|---------|
| <file> | <why important> |

## Output Format                     [REQUIRED]
<What this agent produces when invoked>

---

## Section Applicability by Tier

| Section | Tier 0-1 (Safety) | Tier 2 (Domain) | Tier 3 (Quality) |
|---------|-------------------|-----------------|------------------|
| Purpose | REQUIRED | REQUIRED | REQUIRED |
| Design Philosophy | REQUIRED | OPTIONAL | OPTIONAL |
| When to Invoke | REQUIRED | REQUIRED | REQUIRED |
| Mandatory Consultations | REQUIRED | REQUIRED | REQUIRED |
| Core Patterns | REQUIRED | REQUIRED | REQUIRED |
| Anti-Patterns | REQUIRED (tier 1 only) | OPTIONAL | OPTIONAL |
| Validation Checklist | REQUIRED | REQUIRED | REQUIRED |
| Detection Commands | REQUIRED | REQUIRED | REQUIRED |
| Key Files | REQUIRED | REQUIRED | REQUIRED |
| Output Format | REQUIRED | REQUIRED | REQUIRED |
