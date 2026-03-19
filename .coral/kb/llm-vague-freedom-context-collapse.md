# LLM vague freedom collapses to context defaults

## Rule
When LLM-generated output requires diversity (names, styles, perspectives), never use optional fields with vague instructions like "freely assign diverse values." LLMs interpret unconstrained freedom as permission to follow context defaults — conversation language, recent examples, or training priors. Make diversity-sensitive fields mandatory with explicit distinct values per instance.

## Why
In real sessions, "assign diverse cultural backgrounds freely" produced all-Korean names in Korean conversations, all-Western names in English. A weak model repeated the same name (Junho) 4 times across 4 agents. The instruction had zero effect — LLMs don't actively diversify when the instruction is vague.

## Pattern
Wrong:
```
name_culture (optional): Cultural origin for the persona's name.
# Instruction: "Assign diverse cultural backgrounds freely"
```

Right:
```
# Caller assigns distinct values before spawning:
name_cultures = ["Korean", "Nigerian", "Brazilian", "German"]
# Each agent receives exactly one mandatory value:
name_culture: "Nigerian"  # never omit
```

Key principle: shift diversity enforcement from the generator (LLM) to the orchestrator (deterministic code or explicit caller instructions).
