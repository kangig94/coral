#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[verify-native-binding] npm run build"
npm run build > /dev/null

TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo "[verify-native-binding] spawn smoke in scratch cwd"
cd "$TMPDIR_BASE"

OUT="$(node "$REPO_ROOT/build/coral-backend.cjs" --smoke-open-store --path "$TMPDIR_BASE/s.db")"
echo "[verify-native-binding] output: $OUT"

if [[ "$OUT" != "ok" ]]; then
  echo "[verify-native-binding] FAIL: expected 'ok', got '$OUT'"
  exit 1
fi

if [[ ! -f "$TMPDIR_BASE/s.db" ]]; then
  echo "[verify-native-binding] FAIL: s.db not created"
  exit 1
fi

echo "[verify-native-binding] OK"
