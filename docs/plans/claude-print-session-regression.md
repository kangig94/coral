# Claude Print-Mode New Session Regression

## Status

Implemented and verified on `fix/claude-subscription-auth` on 2026-07-31.

## Reproduction

The development bundle was built from the working tree and invoked directly:

```bash
npm run build:dev
node clients/build/coral-cli.cjs claude -i "hello"
```

The environment had no `ANTHROPIC_API_KEY`; `claude auth status --json`
reported a logged-in Claude.ai subscription. Authentication preflight passed,
then Claude Code 2.1.220 rejected session initialization:

```text
No conversation found with session ID: <new-provider-session-id>
```

## Root Cause

An `exec` request intentionally uses its new Coral provider session ID as the
requested Claude conversation reference and marks `resumeExisting` false.

The TUI child argument builder already preserves that distinction:

- new reference: `--session-id <id>`
- existing reference: `--resume <id>`

The default print transport did not. Its spawn contract carried the reference
but not the new-versus-resume intent, and its argument builder interpreted every
reference as `--resume`. A fresh `exec` therefore asked Claude to resume a
conversation that could not yet exist.

This is separate from authentication-status parsing. The subscription profile
was authenticated successfully before the failing session bootstrap.

## Fix

1. Add an explicit `resume` boolean to the print child spawn contract.
2. Forward `SessionEnsureParams.resumeExisting` through
   `PrintSessionController`.
3. Build print child arguments as follows:
   - no conversation reference: no session-selection flag
   - reference with `resume: false`: `--session-id <id>`
   - reference with `resume: true`: `--resume <id>`
4. Test both argument generation and controller-to-spawn intent propagation.

## Verification

```bash
npx vitest run --config vitest/default.ts \
  tests/unit/providers/claude/appserver/server.test.ts \
  tests/unit/providers/claude/appserver/print-controller.test.ts \
  tests/unit/providers/claude/request-mapping.test.ts \
  tests/unit/providers/claude/cli-detection.test.ts \
  tests/unit/providers/claude/provider-facets.test.ts

npx vitest run --config vitest/default.ts \
  tests/unit/providers/claude/appserver \
  tests/unit/providers/claude/one-shot.test.ts \
  tests/unit/providers/claude/session-kernel.diagnostic.test.ts \
  tests/unit/providers/claude/request-mapping.test.ts

npm run typecheck:tests
npm run build:dev
node clients/build/coral-cli.cjs claude -i "hello"
```

Results:

- focused regression group: 81 tests passed
- Claude appserver regression group: 101 tests passed
- changed-file ESLint, Prettier, and `git diff --check`: passed
- TypeScript test typecheck: passed
- development bundle build: passed
- repository standard test suite: 428 files and 4,147 tests passed
- live bundled command: completed successfully and returned a Claude response
