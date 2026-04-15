# Dev Setup

Keep a local dev build registered next to the marketplace prod install.

## 1. Build the dev bundle

```bash
npm run build:dev
```

This writes the local checkout's `build/manifest.json` with `flavor: "dev"`. To update `bridge/` for commit, use `npm run build:release` instead.

## 2. Register the local hooks in `.claude/settings.local.json`

Use `docs/examples/settings.local.json` as the template for your local settings file. The template points every Coral hook at your local checkout and sets `CLAUDE_PLUGIN_ROOT` so the dev hooks can coexist with the installed prod plugin hooks.

## 3. Select the dev hook flavor for your shell session

```bash
export CORAL_FLAVOR=dev
```

If you use `direnv`, load the same value from `.envrc.example`.

## How it works

- **Daemon identity is intrinsic**: each daemon reads its own `bridge/manifest.json` to determine its flavor. No environment variable tells the daemon what it is.
- **`CORAL_FLAVOR` is a session-level hook selector**: it tells hooks which flavor they should serve. Hooks that don't match the session's flavor exit immediately.
- **KB isolation**: prod markdown → `~/.coral/kb/`, dev → `~/.coral/kb-dev/`. Runtime state (indexes, vectors): prod → `~/.coral/data/kb/`, dev → `~/.coral/data/kb-dev/`. Override markdown root with `CORAL_KB_PATH`.
- **Backend replacement**: if a prod daemon is running and you start a dev session, the dev hooks detect a flavor mismatch on the running backend and trigger replacement. The dev daemon starts at a different namespace (derived from the local plugin root path).

## Verification

After setup, confirm the dev flavor is active:
- `coral-cli backend status` should show `flavor: "dev"` in the health output
- Only dev-registered hooks should fire (check Claude Code hook output)
- KB operations should read/write from `~/.coral/kb-dev/`

## Switching back to prod

Unset `CORAL_FLAVOR` (or close the shell) and launch a new Claude Code session. The default is always prod.
