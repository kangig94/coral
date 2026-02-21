# Discuss — Moderated Multi-Agent Discussion

A structured, turn-based discussion system where multiple AI agents debate a topic with unique personas, managed by an automated moderator. Built on Claude Code Agent Teams and the `dc` MCP server.

## How It Works

```
User: /coral:discuss "Should companies adopt microservices?"

  1. Moderator analyzes topic → decides on 4 personas
  2. Persona generators create unique characters (in parallel)
  3. Discussion session created → Agent Team spawned
  4. Agents bid for speaking turns (0–100 score)
  5. Winner speaks → others read → next round
  6. Discussion ends → moderator synthesizes results
```

## Core Concepts

### Step

A single bidding → speaking cycle. Every time an agent finishes speaking, the step counter increments. Step 1 = first speaker, step 2 = second speaker, and so on.

### Epoch

A quota cycle. Each epoch gives every agent a fresh quota of speaking turns (default: 3). When quotas run out and agents vote to continue, a new epoch begins with restored quotas.

### Quota

Per-agent speaking allowance per epoch. Each "normal" speech costs one quota. When an agent's quota reaches zero, they can only speak via the fallback pool (one-time exception per epoch).

### Bidding Score

Agents express desire to speak with a score from 0 to 100:

| Score Range | Meaning |
|-------------|---------|
| 0 | Nothing to say (signals desire to end) |
| 1–(threshold−1) | Interested but below cutline (cold-start or fallback only) |
| threshold–100 | Eligible to speak normally (higher = stronger desire) |

The default threshold is **50**. Configurable via the `CORAL_DISCUSS_BID_THRESHOLD` environment variable (range: 1–100). The threshold is visible in every `discuss_create` and `discuss_state` response so all participants know the cutline.

## Discussion Flow

### 1. Setup

The moderator (discuss-lead) orchestrates the setup:

1. **Topic Analysis**: Determines 3–8 roles needed (e.g., architect, economist, critic) with diversity hints
2. **Persona Generation**: Spawns persona-generator agents in parallel. Each creates a unique character with name, expertise, perspective, and communication style
3. **Session Creation**: Calls `discuss_create` to initialize the backend state machine
4. **Team Spawn**: Creates an Agent Team and spawns discussant agents, each loaded with their persona

### 2. Bidding Round

```
Moderator broadcasts → "Step N. Call discuss_bid."
   ↓
Each agent submits a bid score (0–100) via discuss_bid
   ↓
Moderator calls discuss_wait("all_bids") — blocks until all bids arrive
   ↓
MCP server auto-resolves the winner (see Resolution Rules below)
```

### 3. Speaking Turn

```
Winner is notified → "You have the floor."
   ↓
Winner reads recent transcript (discuss_transcript)
   ↓
Winner researches evidence (WebSearch)
   ↓
Winner delivers speech (discuss_speak)
   ↓
Moderator waits via discuss_wait("speech_delivered")
   ↓
All agents read the new speech
   ↓
Back to bidding round
```

Speech timeout: The moderator uses a staged wait — first 90 seconds, then a 30-second warning, then force-end if still no speech.

### 4. Termination

The discussion ends through one of these paths:

| Trigger | What Happens |
|---------|--------------|
| All agents bid below bid_threshold (non-cold-start) | Natural end — everyone has said their piece |
| Unanimous termination vote | All agents agree to stop |
| Timeout | Agent doesn't bid or speak in time → force-end |

## Resolution Rules

When all bids are in, the MCP server resolves the winner through a 4-step cascade:

### Step 1: Primary Pool

Agents with **quota remaining** AND **score ≥ bid_threshold** compete. Highest score wins.

**Tiebreaker**: Fewer total speaks wins (fairness) → alphabetical (deterministic).

### Step 2: Fallback Pool

If no primary candidates: agents with **quota exhausted** AND **score ≥ bid_threshold** AND **haven't used fallback** compete. This is a one-time emergency opportunity per epoch.

### Step 3: Cold Start Auto-Pick

If both pools are empty AND it's a cold start (first round of an epoch): the server auto-picks based on fairness (fewest speaks) then desire (highest bid). This ensures discussion always begins.

### Step 4: Vote Required

If both pools are empty but some agents scored >= bid_threshold (structurally blocked — all eligible agents are quota-exhausted and already used fallback): trigger a termination vote.

## Termination Vote

When `vote_required` is triggered:

1. Moderator broadcasts: "Shall we end the discussion? Bid 0 = agree, 1 = disagree"
2. Agents vote via `discuss_bid` (reuses bid infrastructure)
3. **Unanimous (all 0)**: Discussion ends gracefully
4. **Not unanimous**: Quotas reset, new epoch begins

Individual votes are never revealed — not even to the moderator. Vote secrecy is enforced at the API level.

## Epoch Transitions

When a non-unanimous vote triggers a new epoch:

1. All quotas restored to `quota_per_epoch`
2. All `fallback_used` flags cleared
3. `cold_start` set to true
4. Epoch counter incremented
5. Moderator writes epoch summary (recap of previous epoch's arguments)
6. New bidding round begins

This means agents get fresh opportunities and the discussion continues with renewed perspective.

## Discussion Modes

### General Discussion

The default mode. Agents represent diverse perspectives on a topic. The moderator determines appropriate roles based on topic analysis.

### Debate Mode

Activated when the topic involves a clear pro/con divide (e.g., "Should we adopt microservices?"):

1. Personas generated **without** initial stance
2. Session created and team spawned
3. **Stance collection**: Agents declare their initial position (pro/con)
4. **Balance check**: If imbalanced (e.g., 5 pro, 1 con), the moderator reassigns agents as devil's advocates
5. **Persona reinforcement**: Reassigned agents receive supplementary stance-aligned perspective
6. Discussion proceeds normally

Target: 50/50 split (±1 for odd numbers).

## Bid Score Visibility

Bid scores follow strict privacy rules:

| Information | Who Can See |
|-------------|-------------|
| Individual bid scores | Moderator only (via `discuss_wait` auto-resolve response) |
| Individual vote scores | Nobody — not even the moderator |
| Who hasn't bid yet | Everyone (via `pending_bidders` in `discuss_state`) |
| Quota remaining | Everyone (via `agents` in `discuss_state`) |

## Agent Behavior Protocol

### Discussant (Speaker)

Each discussant follows a strict loop:

```
discuss_wait("action_needed") → action returned → act → repeat
```

- **bid**: Submit score based on desire to speak
- **speak**: Read transcript → research → deliver speech → notify moderator
- **vote**: Submit 0 (agree to end) or 1 (disagree, continue)

Agents must call `discuss_wait` before every action. Premature tool calls are rejected by the MCP server with guidance to use `discuss_wait`.

### Moderator (discuss-lead)

The moderator never speaks on substance — only process control:

- Broadcasts bid instructions
- Uses `discuss_wait("all_bids")` for bid collection (auto-resolves winner)
- Uses `discuss_wait("speech_delivered")` for speech detection
- Manages epoch transitions and synthesis
- Never interprets bid scores or picks speakers manually

## Technical Architecture

### State Machine

All discussion rules are internalized in the MCP server's state machine (`state-machine.ts`). The state machine is **pure** — zero I/O, fully testable. State transitions:

```
setup → bidding → speaking → bidding → ... → voting → bidding (new epoch) or ended
                      ↓                          ↓
                   (force-end)              (unanimous vote → ended)
```

The `setup` status is a race-condition gate: `discuss_create` returns immediately with `status: 'setup'`. The `discuss_wait("all_bids")` caller (moderator) transitions to `bidding` under the cross-process lock before accepting bids — ensuring all agents are spawned before bidding begins.

### Cross-Process Safety

Each discussant agent runs its own MCP server process. All state mutations are serialized via a POSIX `mkdir`-based lock — atomic test-and-set with PID tracking and stale lock recovery.

### Session Storage

```
{project}/.claude/coral/discuss/
└── 260221-1430-a1b2-microservices-vs-monolithic/
    ├── state.json          # Atomic writes (write .tmp, rename)
    ├── state.lock/         # Cross-process lock directory
    └── transcript.md       # Human-readable log (incremental append)
```

Sessions are project-local and human-readable. `transcript.md` can be monitored in real-time during a discussion.

### Three-Layer Defense

Agents are prevented from acting out of turn through three independent layers:

1. **`discuss_wait` gating**: Agents call `discuss_wait("action_needed")` before every action. The MCP blocks until it's their turn.
2. **MCP validation**: `discuss_bid` and `discuss_speak` reject out-of-turn calls with error messages guiding agents to use `discuss_wait`.
3. **Agent protocol**: The `<Agent_Prompt>` instructions explicitly state "call `discuss_wait` as your first action."

### Condition-Based Blocking (`discuss_wait`)

The `discuss_wait` MCP tool replaces manual polling with server-side blocking:

| Condition | Blocks Until | Used By |
|-----------|-------------|---------|
| `all_bids` | All agents have submitted bids (auto-resolves winner) | Moderator |
| `speech_delivered` | Current speaker has delivered their speech | Moderator |
| `action_needed` | This specific agent has something to do (bid/speak/vote) | Discussants |

This design keeps the moderator's context window lean — no polling loops, no wasted API calls.

## Transcript Format

The transcript is maintained in both structured (JSON in `state.json`) and human-readable (`transcript.md`) formats:

```markdown
# Should companies adopt microservices?

## Epoch 1

#### Bids — Step 1
| Agent | Score | Quota |
|-------|-------|-------|
| Kim Jimin (conservative-critic) | 85 | 3 |
| Park Soojin (progressive-economist) | 72 | 3 |
> **Winner: Kim Jimin** (normal)

---

### [2026-02-21 14:31:15] Kim Jimin (conservative-critic)

Microservices introduce operational complexity that most organizations
underestimate. Netflix's success is survivorship bias — we don't hear
about the companies that failed during their migration...

---

### [2026-02-21 14:32:48] Park Soojin (progressive-economist)

The economic argument for microservices centers on team independence...
```

### Transcript Read Modes

| Mode | Returns | Access |
|------|---------|--------|
| `recent` | Last N speeches in full, earlier as one-line summaries | Anyone |
| `summary` | All speeches as one-line summaries | Anyone |
| `full` | Complete transcript | Current speaker OR after discussion ends |

The `full` mode restriction ensures agents don't front-run the discussion by reading ahead.

## Configuration

| Environment Variable | Default | Range | Description |
|---------------------|---------|-------|-------------|
| `CORAL_DISCUSS_BID_THRESHOLD` | 50 | 1–100 | Minimum bid score for floor eligibility |

Set in `.claude/settings.json` under the `env` field:
```json
{
  "env": {
    "CORAL_DISCUSS_BID_THRESHOLD": "70"
  }
}
```

The threshold is stored per-session at creation time (not re-read from env mid-session) and surfaced in `discuss_create` and `discuss_state` responses so all participants know the cutline.

## Quick Reference

| Concept | Value | Notes |
|---------|-------|-------|
| Default bid threshold | 50 | Configurable via `CORAL_DISCUSS_BID_THRESHOLD` (1–100) |
| Session status on create | `setup` | Transitions to `bidding` when moderator calls `discuss_wait("all_bids")` |
| Default quota | 3 per epoch | Configurable via `quota_per_epoch` |
| Max agents | 8 | Min: 2 |
| Recent turns | 5 | Configurable via `recent_turns` |
| Cold start | Auto-pick | Server picks fairest agent to break the ice |
| Fallback | One-time per epoch | Quota-exhausted agents get one emergency turn |
| Vote secrecy | API-level | Individual votes never returned by any tool |
| Team name | `coral-dc-{session_id}` | Deterministic from session ID |
| Teammate prefix | `dc-{agent_name}` | Hook integration contract |
