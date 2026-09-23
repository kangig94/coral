#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[verify-native-binding] npm run build"
npm run build

TMPDIR_BASE="$(mktemp -d)"
cleanup() {
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

TEST_HOME="$TMPDIR_BASE/home"
mkdir -p "$TEST_HOME"

echo "[verify-native-binding] initialize canonical epoch"
HOME="$TEST_HOME" node "$REPO_ROOT/clients/build/coral-cli" backend store-reset discard --target gen2 --flavor prod >/dev/null
STORE_PATH="$TEST_HOME/.coral/gen2/data/store/epoch-1/store.db"

echo "[verify-native-binding] spawn smoke in scratch cwd"
cd "$TMPDIR_BASE"

OUT="$(HOME="$TEST_HOME" node "$REPO_ROOT/clients/build/coral-backend.cjs" --smoke-open-store --path "$STORE_PATH")"
echo "[verify-native-binding] output: $OUT"

if [[ "$OUT" != "ok" ]]; then
  echo "[verify-native-binding] FAIL: expected 'ok', got '$OUT'"
  exit 1
fi

if [[ ! -f "$STORE_PATH" ]]; then
  echo "[verify-native-binding] FAIL: canonical epoch is absent"
  exit 1
fi

echo "[verify-native-binding] OK"
