# Dev Setup

Keep a local dev build registered next to the marketplace prod install.

## 1. Build the dev bundle

```bash
npm run build:dev
```

This writes the local checkout's `clients/build/manifest.json` with `flavor: "dev"`. `clients/bridge/` is rebuilt and committed only by the Release workflow at release time — never by hand in feature work; run `npm run build:release` locally only if you need refreshed prod `clients/bridge/` bundles to test against.

## 2. Register the local hooks in `.claude/settings.local.json`

Keep `.claude/settings.local.json` machine-local. The plugin surface lives under `clients/`, so point the Coral hooks at `<checkout>/clients/hooks/*.mjs`, set `CLAUDE_PLUGIN_ROOT` to `<checkout>/clients`, and register `CORAL_FLAVOR=dev` in the settings `env` block so the dev hooks can coexist with the installed prod plugin hooks.

## How it works

- **Daemon identity is intrinsic**: each daemon reads its own `bridge/manifest.json` to determine its flavor. No environment variable tells the daemon what it is.
- **`CORAL_FLAVOR` is a settings-level hook selector**: hooks read it from their process environment, so local dev setup records it in `.claude/settings.local.json` under `env`. Hooks that don't match the selected flavor exit immediately.
- **KB isolation**: prod markdown → `~/.coral/kb/`, dev → `~/.coral/kb-dev/`. Runtime state (indexes, vectors): prod → `~/.coral/gen2/data/kb/`, dev → `~/.coral/gen2/data-dev/kb/`. Override markdown root with `CORAL_KB_PATH`.
- **Backend replacement**: if a prod daemon is running and you start a dev session, the dev hooks detect a flavor mismatch on the running backend and trigger replacement. The dev daemon starts at a different namespace (derived from the local plugin root path).

## Verification

After setup, confirm the dev flavor is active:
- `coral-cli backend status` should show `flavor: "dev"` in the health output
- Only dev-registered hooks should fire (check Claude Code hook output)
- KB operations should read/write from `~/.coral/kb-dev/`

## Switching back to prod

Remove `CORAL_FLAVOR` from the settings `env` block (or switch back to a prod settings file) and launch a new Claude Code session. The default is always prod.
