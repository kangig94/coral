#!/usr/bin/env bash
#
# verify-native-binding.sh — AC8 scratch-dir native-binding smoke.
#
# Builds the backend bundle, then spawns `build/coral-backend.cjs --smoke-open-store`
# from a fresh tempdir (outside the repo) to prove better-sqlite3 loads, openStoreDatabase
# resolves migrations via bundle-aware paths, and a round-trip append+read succeeds.
#
# Usage:  bash scripts/verify-native-binding.sh
# Exit 0 + prints "OK" on success; exit 1 on failure.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[verify-native-binding] npm run build"
npm run build > /dev/null

mkdir -p "$REPO_ROOT/bridge"
cp "$REPO_ROOT/build/coral-backend.cjs" "$REPO_ROOT/bridge/coral-backend.cjs"
cp "$REPO_ROOT/build/manifest.json" "$REPO_ROOT/bridge/manifest.json"

TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo "[verify-native-binding] spawn smoke in scratch cwd"
cd "$TMPDIR_BASE"

OUT="$(node "$REPO_ROOT/bridge/coral-backend.cjs" --smoke-open-store --path "$TMPDIR_BASE/s.db")"
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
