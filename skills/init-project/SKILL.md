---
name: init-project
description: Initialize project for AI-assisted development with rules, agents, CLAUDE.md, docs, and settings
argument-hint: "[existing|new]"
---

# Project Initialization

Set up a project for AI-assisted development. Scans the project, plans appropriate artifacts with architect/critic review, then generates everything.

## Execution

1. **Load protocol**: Read `agents/init-project.md` to load the full init-project protocol
2. **Execute protocol**: Follow the orchestration phases (scan → plan → execute → report)
3. **Present report**: Show the final report to the user

## Context Enhancement

From the current conversation, identify and include:
- Whether this is an existing or new project (from argument)
- Reference material provided by the user (repos, docs, URLs)
- Tech stack or architectural preferences mentioned
- Any specific requirements or constraints

## Error Policy

If `agents/init-project.md` cannot be read, report the error to the user.
