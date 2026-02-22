# Discuss - Moderated Multi-Agent Discussion

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

A quota cycle. Each epoch gives every agent a fresh quota of speaking turns (default: 3). When all agents exhaust both quota AND fallback turns, the server automatically transitions to a new epoch (up to `max_epochs`, default: 2).

### Quota

Per-agent speaking allowance per epoch. Each "normal" speech costs one quota. When an agent's quota reaches zero, they can only speak via the fallback pool (one-time exception per epoch).

### Bidding Score

Agents express desire to speak with a score from 0 to 100:

| Score Range | Meaning |
|-------------|---------|
| 0 | Nothing to say (signals desire to end) |
| 1–(threshold−1) | Interested but below cutline (cold-start or fallback only) |
| threshold–100 | Eligible to speak normally (higher = stronger desire) |

The default threshold is **50**. Configurable via the `CORAL_DISCUSS_BID_THRESHOLD` environment variable (range: 1–100). The threshold is visible in every `discuss({ op: "create", ... })` and `discuss({ op: "state", ... })` response so all participants know the cutline.

## Discussion Flow

### 1. Setup

The moderator (discuss-lead) orchestrates a 3-phase setup. See [Persona Seeding Algorithm](mcp-tools.md#persona-seeding-algorithm-_1_seed) for full algorithm details.

1. **Controversy Analysis** (LLM inline): Extract 3–4 controversy axes from the topic (each with 2–3 positions, pool budget ≤ 81). Assign `dc-`-prefixed agent names, distinct `name_culture` per agent, and generate persona briefs. For debate topics, prepend a stance axis.
2. **DPP Seeding**: Call `discuss_lead({ op: "_1_seed", controversy_axes, n })` → k-DPP sampling returns maximally diverse position + tone assignments, each with a `persona_seed` uint32. Pools > 256 are auto-subsampled (graceful degradation). Handle `pool_too_large` (> 100,000) / `pool_degenerate` errors by adjusting axes.
3. **Persona Generation**: Spawn `persona-generator` agents in parallel, each receiving: role, positions (from DPP), tone, brief, and optional `devil_advocate` flag (stance imbalance correction).
4. **Session Creation**: Call `discuss_lead({ op: "_2_create", topic, agents })` → get `session_id`
5. **Team Spawn**: Create Agent Team `coral-dc-{session_id}`, spawn `discussant` teammates with persona text

### 2. Bidding Round

```
Moderator broadcasts → "Step N. Call `discuss({ op: "bid", ... })`."
   ↓
Each agent submits a bid score (0–100) via `discuss({ op: "bid", ... })`
   ↓
Moderator calls discuss({ op: "wait", condition: "all_bids", ... }) - blocks until all bids arrive
   ↓
MCP server auto-resolves the winner (see Resolution Rules below)
```

### 3. Speaking Turn

```
Winner is notified → "You have the floor."
   ↓
Winner reads recent transcript (`discuss({ op: "transcript", ... })`)
   ↓
Winner researches evidence (WebSearch)
   ↓
Winner delivers speech (`discuss({ op: "speak", ... })`)
   ↓
Moderator waits via discuss({ op: "wait", condition: "speech_delivered", ... })
   ↓
All agents read the new speech
   ↓
Back to bidding round
```

Speech timeout: The moderator uses a staged wait - first 90 seconds, then a 30-second warning, then force-end if still no speech.

### 4. Termination

The discussion ends through one of these paths:

| Trigger | What Happens |
|---------|--------------|
| All agents bid below bid_threshold (non-cold-start) | Natural end - everyone has said their piece |
| All blocked (quota+fallback exhausted for some, others below threshold) | Server returns no_winner - moderator synthesizes |
| Max epochs reached (all exhausted, epoch >= max_epochs) | Server returns no_winner + max_epochs_reached - moderator synthesizes |
| Timeout | Agent doesn't bid or speak in time → force-end |

## Resolution Rules

When all bids are in, the MCP server resolves the winner through a cascade:

### Step 1: Primary Pool

Agents with **quota remaining** AND **score ≥ bid_threshold** compete. Highest score wins.

**Tiebreaker**: Fewer total speaks wins (fairness) → alphabetical (deterministic).

### Step 2: Fallback Pool

If no primary candidates: agents with **quota exhausted** AND **score ≥ bid_threshold** AND **haven't used fallback** compete. This is a one-time emergency opportunity per epoch.

### Step 3: Cold Start Auto-Pick

If both pools are empty AND it's a cold start (first round of an epoch): the server auto-picks based on fairness (fewest speaks) then desire (highest bid). This ensures discussion always begins.

### Step 4: allExhausted Gate → Epoch Transition

If both pools are empty (not cold-start) and some bids ≥ bid_threshold:

- **allExhausted** (every agent: `quota_remaining === 0` AND `fallback_used === true`):
  - If `epoch < max_epochs` → **auto epoch transition** (quotas reset, epoch incremented, new bidding round)
  - If `epoch >= max_epochs` → **max_epochs_reached** → moderator synthesizes
- **NOT allExhausted** (some agents still have quota but bid below threshold) → **all_blocked** → moderator synthesizes

## Epoch Transitions

Epoch transitions are **automatic** - no agent vote required.

When the server detects allExhausted (all agents have used quota AND fallback) with remaining desire (some bids ≥ threshold) AND `epoch < max_epochs`:

1. All quotas restored to `quota_per_epoch`
2. All `fallback_used` flags cleared
3. `cold_start` set to true
4. Epoch counter incremented
5. All agents' `transcript_read_step` stamped to the new step (no forced re-read at epoch boundary)
6. Moderator writes epoch summary (recap of previous epoch's arguments)
7. New bidding round begins

**Sealed-bid design**: Individual bid scores are never returned in any API response. They are recorded in `state.json` for audit but hidden from all agents - including the moderator. The winner's identity is revealed; scores are not.

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

## Bid Score Visibility (Sealed-Bid Design)

Bid scores are sealed - they are never returned in any API response:

| Information | Who Can See |
|-------------|-------------|
| Individual bid scores | Nobody via API (audit only in `state.json`) |
| Winner identity | Everyone (via `discuss({ op: "wait", ... })` → winner field, `formatFull` → "Speaker: Name") |
| Who hasn't bid yet | Moderator (via `pending_bidders` indirectly) |
| Total speaks (`your_speaks`) | Agent themselves (via `discuss({ op: "wait", condition: "action_needed", ... })` response) |
| Bid threshold | Everyone (visible in `discuss({ op: "state", ... })`) |

## Agent Behavior Protocol

### Discussant (Speaker)

Each discussant follows a strict loop:

```
discuss({ op: "wait", condition: "action_needed", ... }) → action returned → act → repeat
```

- **bid**: Submit score based on desire to speak
- **speak**: Read transcript → research → deliver speech → notify moderator

Agents must call `discuss({ op: "wait", ... })` before every action. Premature tool calls are rejected by the MCP server with guidance to use `discuss({ op: "wait", ... })`.

### Moderator (discuss-lead)

The moderator never speaks on substance - only process control:

- Broadcasts bid instructions
- Uses `discuss({ op: "wait", condition: "all_bids", ... })` for bid collection (auto-resolves winner)
- Uses `discuss({ op: "wait", condition: "speech_delivered", ... })` for speech detection
- Manages epoch transitions and synthesis
- Never interprets bid scores or picks speakers manually

## Technical Architecture

### State Machine

All discussion rules are internalized in the MCP server's state machine (`state-machine.ts`). The state machine is **pure** - zero I/O, fully testable. State transitions:

```
setup → bidding → speaking → bidding → ... → bidding (epoch auto-transition) or ended
                      ↓
                   (force-end)
```

The `setup` status is a race-condition gate: `discuss({ op: "create", ... })` returns immediately with `status: 'setup'`. The `discuss({ op: "wait", condition: "all_bids", ... })` caller (moderator) transitions to `bidding` under the cross-process lock before accepting bids - ensuring all agents are spawned before bidding begins.

### Cross-Process Safety

Each discussant agent runs its own MCP server process. All state mutations are serialized via a POSIX `mkdir`-based lock - atomic test-and-set with PID tracking and stale lock recovery.

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

1. **`discuss({ op: "wait", ... })` gating**: Agents call `discuss({ op: "wait", condition: "action_needed", ... })` before every action. The MCP blocks until it's their turn.
2. **MCP validation**: `discuss({ op: "bid", ... })` and `discuss({ op: "speak", ... })` reject out-of-turn calls with error messages guiding agents to use `discuss({ op: "wait", ... })`.
3. **Agent protocol**: The `<Agent_Prompt>` instructions explicitly state "call `discuss({ op: "wait", ... })` as your first action."

### Condition-Based Blocking (`discuss({ op: "wait", ... })`)

The `discuss({ op: "wait", ... })` MCP tool replaces manual polling with server-side blocking:

| Condition | Blocks Until | Used By |
|-----------|-------------|---------|
| `all_bids` | All agents have submitted bids (auto-resolves winner) | Moderator |
| `speech_delivered` | Current speaker has delivered their speech | Moderator |
| `action_needed` | This specific agent has something to do (bid/speak) | Discussants |

This design keeps the moderator's context window lean - no polling loops, no wasted API calls.

## Transcript Format

The transcript is maintained in both structured (JSON in `state.json`) and human-readable (`transcript.md`) formats:

```markdown
# Should companies adopt microservices?

## Epoch 1

#### Bids - Step 1
| Agent | Score | Quota |
|-------|-------|-------|
| Kim Jimin (conservative-critic) | 85 | 3 |
| Park Soojin (progressive-economist) | 72 | 3 |
> **Winner: Kim Jimin** (normal)

---

### [2026-02-21 14:31:15] Kim Jimin (conservative-critic)

Microservices introduce operational complexity that most organizations
underestimate. Netflix's success is survivorship bias - we don't hear
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
| `CORAL_DISCUSS_MAX_EPOCHS` | 2 | 1–10 | Max epochs before discussion ends automatically |

Set in `.claude/settings.json` under the `env` field:
```json
{
  "env": {
    "CORAL_DISCUSS_BID_THRESHOLD": "70",
    "CORAL_DISCUSS_MAX_EPOCHS": "3"
  }
}
```

Both values are stored per-session at creation time (not re-read from env mid-session). `bid_threshold` is surfaced in `discuss({ op: "state", ... })`. `max_epochs` is returned in the `discuss({ op: "create", ... })` response.

## Quick Reference

| Concept | Value | Notes |
|---------|-------|-------|
| Default bid threshold | 50 | Configurable via `CORAL_DISCUSS_BID_THRESHOLD` (1–100) |
| Default max epochs | 2 | Configurable via `CORAL_DISCUSS_MAX_EPOCHS` (1–10) |
| Session status on create | `setup` | Transitions to `bidding` when moderator calls `discuss({ op: "wait", condition: "all_bids", ... })` |
| Default quota | 3 per epoch | Configurable via `CORAL_DISCUSS_QUOTA_PER_EPOCH` (1–10) |
| Max agents | 8 | Min: 2 |
| Recent turns | 5 | Default for `_4_transcript` recent mode (override with `last_n`) |
| Cold start | Auto-pick | Server picks fairest agent to break the ice |
| Fallback | One-time per epoch | Quota-exhausted agents get one emergency turn |
| Epoch transition | Auto (no vote) | Server triggers when allExhausted + epoch < max_epochs |
| Bid scores | Sealed (audit only) | Never returned in any API response; winner identity revealed |
| Team name | `coral-dc-{session_id}` | Deterministic from session ID |
| Teammate prefix | `dc-{agent_name}` | Hook integration contract |
