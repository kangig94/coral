---
name: discuss
description: "Use when a topic benefits from multiple perspectives debating before a decision."
argument-hint: "[--user] [topic] [--hints axis1:pos1,pos2 axis2:pos1,pos2]"
---

# Moderated Multi-Agent Discussion

Start a backend-managed structured discussion with AI agents.
Pass `--user` to participate as a human observer.

## Execution

1. **If no topic is provided**: gather it interactively, plus:
   - participant count (2-8, default: 4)
   - debate vs open discussion
   - requested roles or perspectives

2. **Analyze the topic** and prepare persona inputs.
   - Identify the professional domain and the main disagreement axes.
   - If geographic or institutional origin matters, prepare `demographics: { origin_weights, outlier_ratio }`.
   - Write a 1-2 sentence background brief per slot.
   - Assign a distinct name culture per slot.

3. **Generate persona seeds** with:
   `discuss_seed({ controversy_axes, n, demographics?, seed })`

4. **Turn the seed output into personas**.
   - Use the seed positions, tone, and any `suggested_origin` / `is_outlier` fields.
   - Reuse your normal persona-generation workflow if you have one.
   - Keep agent names stable and tool-safe.

5. **Build the agent list** and start the session.
   - Required AI agents use `{ name, persona, provider?, model? }`.
   - If `--user`, add:
     `{ name: 'user', persona: '# User — Human Participant\nHuman observer with real-time participation via /bid skill.', participation: 'observer' }`
   - Start with:
     `discuss_start({ topic, agents, config: { min_bid_delay_ms: 10000 } })` for `--user`
     or `discuss_start({ topic, agents })` otherwise.
   - Save the returned `session` as `session_id`.

6. **If `--user`**, write `$CORAL_DATA/discuss/active-user-session.json`
   with `{ session_id }`.
   This keeps `/bid` pointed at the active observer session.

7. **Monitor progress** by polling:
   `discuss_watch({ session: session_id })`
   - First poll: omit `cursor` to get full history.
   - Subsequent polls: pass the returned `cursor` value to get only new events:
     `discuss_watch({ session: session_id, cursor: previous_cursor })`
   - Show new `speech_done` events as they appear.
   - Watch for `epoch_transition` and `session_ended`.
   - Do not expect sealed-bid internals in this payload.

8. **If `--user`**, return immediately:
   "Discussion started! Use `/bid <score>, <thought>` to submit a bid, or `/bid <your speech>` when you win the floor."

9. **When the session ends**, report the end reason from `discuss_watch`.
   - If `--user`, delete `$CORAL_DATA/discuss/active-user-session.json`.

## Context Enhancement

From the user’s request, identify:
- discussion topic
- `--user` mode
- preferred team size
- debate vs open discussion
- requested perspectives
- any controversy hints passed through `--hints`
