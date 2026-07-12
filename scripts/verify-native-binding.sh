#!/usr/bin/env bash
#
# verify-native-binding.sh — AC8 scratch-dir native-binding smoke.
#
# Builds the backend bundle, then spawns `build/coral-backend.cjs --smoke-open-store`
# from a fresh tempdir (outside the repo) to prove better-sqlite3 loads, openStoreDatabase
# resolves schemas via bundle-aware paths, and a round-trip append+read succeeds.
#
# Usage:  bash scripts/verify-native-binding.sh
# Exit 0 + prints "OK" on success; exit 1 on failure.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[verify-native-binding] npm run build"
npm run build

BRIDGE_BUNDLE="$REPO_ROOT/clients/bridge/coral-backend.cjs"
BRIDGE_MANIFEST="$REPO_ROOT/clients/bridge/manifest.json"
BRIDGE_BUNDLE_PREEXISTING=0
BRIDGE_MANIFEST_PREEXISTING=0
if git -C "$REPO_ROOT" ls-files --error-unmatch clients/bridge/coral-backend.cjs >/dev/null 2>&1; then BRIDGE_BUNDLE_PREEXISTING=1; fi
if git -C "$REPO_ROOT" ls-files --error-unmatch clients/bridge/manifest.json >/dev/null 2>&1; then BRIDGE_MANIFEST_PREEXISTING=1; fi

mkdir -p "$REPO_ROOT/clients/bridge"
cp "$REPO_ROOT/clients/build/coral-backend.cjs" "$BRIDGE_BUNDLE"
cp "$REPO_ROOT/clients/build/manifest.json" "$BRIDGE_MANIFEST"

TMPDIR_BASE="$(mktemp -d)"
cleanup() {
  rm -rf "$TMPDIR_BASE"
  if [[ $BRIDGE_BUNDLE_PREEXISTING -eq 1 ]]; then
    git -C "$REPO_ROOT" checkout -- clients/bridge/coral-backend.cjs 2>/dev/null || true
  else
    rm -f "$BRIDGE_BUNDLE"
  fi
  if [[ $BRIDGE_MANIFEST_PREEXISTING -eq 1 ]]; then
    git -C "$REPO_ROOT" checkout -- clients/bridge/manifest.json 2>/dev/null || true
  else
    rm -f "$BRIDGE_MANIFEST"
  fi
}
trap cleanup EXIT

echo "[verify-native-binding] spawn smoke in scratch cwd"
cd "$TMPDIR_BASE"

OUT="$(node "$BRIDGE_BUNDLE" --smoke-open-store --path "$TMPDIR_BASE/s.db")"
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
