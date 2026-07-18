# Knowledge Base

## Search
Source code and official docs (via WebFetch) are the source of truth — always start there.
KB stores past decisions and lessons learned. Search it when you're stuck, not as a first step.
`kb read` returns note age — older notes may be stale, so verify against current code before acting.
1. `CLI kb principles` — list principle names (cross-domain decision patterns). Names are self-descriptive (e.g., `atomic-persistence-or-nothing`). Use `--verbose` for statements and referring notes.
2. `CLI kb search "<keywords>"` — searches filename, principles, tags, title, content. Returns top 20 results ranked by relevance. Use `--scope notes|sources|communities|all` to filter by entry type (default: `all`).
3. `CLI kb read <slug>` — read an entry by slug. Resolves memo → note → wiki → community → source → principle precedence. Use `kb read sources:<slug>` / `kb read communities:<slug>` / `kb read wiki:<slug>` for explicit access. Always use this instead of reading KB files directly.
4. `CLI kb source list` — list imported source documents with metadata.
