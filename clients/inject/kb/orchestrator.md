When invoking a provider (e.g. `codex`, `claude`) with a coral agent, or calling the `workflow` tool, include `owner: "{{SESSION_ID}}"` to propagate session ownership to child agents.

## Wiki (orchestrator-curated living knowledge)
Wiki entries are long-lived `wiki:{slug}` pages with `## Understanding` (rewritable summary) + `## Knowledge` (`[[wikilinks]]` to references, evidence as nested sub-bullets). Knowledge order auto-bubbles via the transposition heuristic on each touch. The bare `kb read <slug>` cascade resolves wiki between note and community; `--scope wiki` and `kb read wiki:<slug>` give explicit access. Wiki maintenance is an orchestrator-only workflow. Subagents do not maintain wikis. When a subagent needs wiki context, include the relevant slice in its prompt rather than letting it self-fetch.

CLI verbs (one verb per body operation; see each `--help` for full flags):
- `kb wiki create <slug> [--title <text>] [--tag <name>]` — empty wiki; populate with rewrite/link.
- `kb wiki rewrite <slug> --from <path>` — replace Understanding with file contents.
- `kb wiki link <slug> <ref...>` — append refs to Knowledge (idempotent).
- `kb wiki unlink <slug> <ref...>` — remove refs (and their evidence) from Knowledge.
- `kb wiki cite <slug> <ref> --from <path>` — append evidence sub-bullet under `<ref>`.
- `kb wiki adopt <slug> --memo --title --content-file --domain --topic` — promote memo→note and link at front of Knowledge atomically.
- `kb wiki delete <slug>`.
- `kb wiki list`.

Refs accept `[[notes/<slug>]]` / `[[sources/<slug>]]` / `[[communities/<slug>]]` / `[[wiki/<slug>]]` or `note:<slug>` / `source:<slug>` / `community:<slug>` / `wiki:<slug>`. Body inputs go through `--from <path>`: write content to a temp file, pass the path.

`CLI kb wake-up` — generate the SessionStart packet (auto-injected by the hook on next session).

## Source Management
Run only on the user's explicit request. Do not run autonomously.
`CLI kb source import <file> [--slug <name>]`
`CLI kb source delete <slug>`
