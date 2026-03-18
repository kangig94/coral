# Codex Compact Context Overflow
Promoted: 2026-03-18 | Updated: 2026-03-18
## Rule
Codex auto-compact triggers at 90% of `context_window` and trims assistant-generated items, but tool results (file contents) are preserved. If tool results alone exceed the context window, the compact API call itself fails with `context_length_exceeded`. This is a structural limitation, not an algorithm bug.

## Why
A single Codex session that reads many large files across exploration steps can accumulate enough tool result tokens to exceed the window before compaction runs. The compact request sends the full conversation to the model, which rejects it. Symptoms: job hangs or errors at a late exploration step after many file reads.

## Pattern
Right: split large codebase exploration across multiple Codex sessions, or use a model with a larger context window.
Wrong: retry the same session — compact will fail again with the same payload.

Context: observed in job `713ede43` exploring 19 CUDA source files in synthray/meturay.
