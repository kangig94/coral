---
name: bid
description: Submit a bid or speech in an active --user discuss session
argument-hint: "<score>, <thought> | <speech content>"
---

# Bid / Speak in Active Discussion

Submit a bid or speech as the `user` observer in a running `--user` discuss session.

## Pre-flight Check

If the conversation context shows no active `--user` discuss session,
respond: "No active --user discuss session. Start one with `/discuss --user <topic>`."
Then STOP — do not proceed.

## Parse Rule

Split args on the **first comma**:
- If the left side (trimmed) is a bare integer 0–100: **bid mode** → `score = left`, `thought = right.trimmed`
  - If thought is empty → error: "Bid requires a thought. Usage: `/bid <score>, <thought>`"
- Otherwise: **speech mode** → entire string is speech content

**Examples**:
- `/bid 50, I want to address the scalability concern` → bid(50, "I want to address the scalability concern")
- `/bid 0, nothing to add` → bid(0, "nothing to add")
- `/bid I think we should use a microservices approach` → speak("I think we should use a microservices approach")
- `/bid 80` → bid mode detected, but thought empty → error
- `/bid I think 80 is right` → speak("I think 80 is right")

## Bid Mode Flow

1. Call `discuss({ op: 'bid', session, agent_name: 'user', score, thought })`
2. On `action: 'speak'` → "You won the floor! Type `/bid <your speech>` to deliver your speech."
3. On `action: 'listen'` → show the speaker and speech content summary
4. On `action: 'session_ended'` → "Discussion ended." Clean up `active-user-session.json`.

## Speech Mode Flow

1. Call `discuss_lead({ op: '_6_state', session })` → verify `current_speaker === 'user'`
2. If not user's turn → "It's not your turn yet. Wait to win the floor, then use `/bid <speech>`."
3. Call `discuss({ op: 'speak', session, agent_name: 'user', content })`
4. "Speech recorded. Waiting for next round..."

## Error Policy

- Session ended mid-bid → "Discussion ended." Clean up `active-user-session.json`.
- speak() error → "Speech timed out or already recorded. Wait for discuss-lead guidance."
