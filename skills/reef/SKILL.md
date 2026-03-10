---
name: reef
description: Launch the coral-reef dashboard (auto-install, build, and start)
argument-hint: "[--rebuild]"
---

# Coral Reef Dashboard

Launch the coral-reef dashboard. Handles installation, updates, builds, and startup automatically.

The runtime injects `Base directory for this skill:` which resolves to this skill's installed path.
From there, the plugin root is two levels up, and `coral-reef/` sits as a sibling directory.

## Constants

```
REPO_URL = "https://github.com/kangig94/coral-reef"
REEF_DATA_DIR = ~/.claude/coral-reef/
REEF_PORT = 3100
```

## Protocol

### Step 1 — Resolve Paths

Derive the plugin root from the base directory injected by the framework:

```
PLUGIN_ROOT = resolve(base_directory, "../..")
REEF_DIR = resolve(PLUGIN_ROOT, "coral-reef")
```

Verify `PLUGIN_ROOT` contains `package.json` with `"name": "coral"` as a sanity check.

### Step 2 — Ensure Data Directory

```bash
mkdir -p ~/.claude/coral-reef
```

This is coral-reef's permanent SQLite storage location, surviving `/tmp` reboots.

### Step 3 — Clone or Update

Check if `REEF_DIR` exists:

- **Not exists**: `git clone ${REPO_URL} ${REEF_DIR}`
- **Exists with `.git/`**: `cd ${REEF_DIR} && git pull --ff-only`
- **Exists without `.git/`**: warn user and skip update (manual install)

### Step 4 — Dependency Resolution

Detect the install layout by checking if this is a nested plugin install or a dev workspace:

```bash
# Read coral-reef's package.json
cd ${REEF_DIR}
```

Check if the `coral` dependency in `package.json` points to the correct location:

- **Dev workspace layout** (`~/workspace/coral-reef` sibling to `~/workspace/coral`):
  The `coral` dependency should be `"file:../coral"`. Leave as-is.

- **Nested plugin install** (`${PLUGIN_ROOT}/coral-reef/` inside `${PLUGIN_ROOT}/`):
  The `coral` dependency should be `"file:.."` (parent is the plugin root = coral itself).
  If it currently says `"file:../coral"`, rewrite it to `"file:.."`.

Rewrite logic (only when nested):
```bash
# Read package.json, replace "file:../coral" with "file:.." in the coral dependency
```

Use `jq` or a JSON-safe read/write to avoid breaking package.json.

### Step 5 — Install and Build

```bash
cd ${REEF_DIR}
npm install
npm run build
```

If `--rebuild` argument is provided, always run the full install + build even if `node_modules/` exists.

If no `--rebuild` and `node_modules/` exists and `bridge/` (build output) exists, skip install/build and go straight to start.

### Step 6 — Start Server

Check if coral-reef is already running on port 3100:

```bash
curl -s http://localhost:3100/api/system/health
```

- **Already running**: inform user, skip to Step 7
- **Not running**: start in background:
  ```bash
  cd ${REEF_DIR} && node dist/server/index.js &
  ```
  Wait up to 5 seconds for the health endpoint to respond.

### Step 7 — Open Browser

```bash
open http://localhost:3100  # macOS
xdg-open http://localhost:3100  # Linux
```

Report the dashboard URL to the user.

## Error Handling

| Scenario | Action |
|----------|--------|
| `git clone` fails | Report error with URL, suggest manual clone |
| `git pull --ff-only` fails | Warn about local changes, suggest `--rebuild` after manual resolution |
| `npm install` fails | Show error output, check if coral dependency path is correct |
| `npm run build` fails | Show error output, suggest `--rebuild` to retry clean |
| Port 3100 in use by non-reef process | Warn user, show what's on the port |
| `PLUGIN_ROOT` sanity check fails | Error: cannot determine coral plugin root |

## Notes

- The dashboard data persists at `~/.claude/coral-reef/db.sqlite` across sessions
- The server connects to the coral backend via SSE for live updates
- If the coral backend is not running, the dashboard still shows historical data from SQLite
- Use `--rebuild` to force a clean install + build (useful after coral updates)
