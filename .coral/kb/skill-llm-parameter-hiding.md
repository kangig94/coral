# Hide Optional Parameters with Sensible Defaults from LLM Skill Prompts
## Rule
When a tool parameter has a good default value and LLM exposure causes it to override with worse values, remove the parameter from the skill prompt entirely. The LLM will omit it, and the default applies.
## Why
LLMs compulsively fill in visible parameters even when the default is correct. Example: `wait({ timeout_seconds })` with a 600s default — LLMs consistently set it to 120s, causing reviewer timeouts on tasks that need 5+ minutes.
## Pattern
```
# Wrong — LLM sees parameter, sets bad value
wait({ sessions: pendingSessions, timeout_seconds: 120 })

# Right — parameter hidden, 600s default applies
wait({ sessions: pendingSessions })
```
