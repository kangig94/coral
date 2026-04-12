# Dev Setup

Keep a local dev build registered next to the marketplace prod install.

## 1. Build the dev bundle

```bash
npm run build:dev
```

This writes the local checkout's `bridge/manifest.json` with `flavor: "dev"`.

## 2. Register the local hooks in `.claude/settings.local.json`

Use `docs/examples/settings.local.json` as the template for your local settings file. The template points every Coral hook at `/home/kang/workspace/coral` and sets `CLAUDE_PLUGIN_ROOT` to that checkout so the dev hooks can coexist with the installed prod plugin hooks.

## 3. Select the dev hook flavor for your shell session

```bash
export CORAL_FLAVOR=dev
```

If you use `direnv`, load the same value from `.envrc.example`.
