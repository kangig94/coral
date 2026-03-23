---
name: bid
description: Submit a bid or speech in an active --user discuss session
argument-hint: "<score>, <thought> | <speech content>"
---

# Bid / Speak in Active Discussion

Submit a bid or speech as the `user` observer in a running `--user` discuss session.

## Pre-flight Check

Resolve `session` by reading `CORAL_PROJECT/discuss/active-user-session.json`.
If that file does not exist or does not contain a valid active session,
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

1. Call `discuss_participate({ session, agent_name: 'user', score, thought })`
2. On `action: 'listen'` → "Bid recorded. Wait for the discuss watch output to show whether you won the floor."
3. On `action: 'session_ended'` → "Discussion ended." Delete `CORAL_PROJECT/discuss/active-user-session.json`.

## Speech Mode Flow

1. Call `discuss_participate({ session, agent_name: 'user', content })`
2. On `action: 'speech_recorded'` → "Speech recorded. Waiting for next round..."
3. On `action: 'not_your_turn'` → "It's not your turn yet. Wait to win the floor, then use `/bid <speech>`."
4. On `action: 'session_ended'` → "Discussion ended." Delete `CORAL_PROJECT/discuss/active-user-session.json`.

## Error Policy

- Session ended mid-bid → "Discussion ended." Delete `CORAL_PROJECT/discuss/active-user-session.json`.
- speak() error → "Speech was not recorded. Wait for the next watch update, then try again if needed."
