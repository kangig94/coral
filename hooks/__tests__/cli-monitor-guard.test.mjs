#!/usr/bin/env node
// Standalone smoke tests for hooks/cli-monitor-guard.mjs.
// Run: node hooks/__tests__/cli-monitor-guard.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'cli-monitor-guard.mjs');
const PLUGIN_ROOT = join(HERE, '..', '..');
const ACTIVE_BRIDGE = join(PLUGIN_ROOT, 'bridge', 'coral-cli.cjs');

function runHook(payload) {
  return new Promise((res, rej) => {
    const env = { ...process.env };
    delete env.CORAL_CHILD;
    delete env.CORAL_FLAVOR;
    const child = spawn('node', [HOOK], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => res({ code, stdout, stderr }));
    child.on('error', rej);
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const monitor = (command) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Monitor',
  tool_input: { command, description: 'test', persistent: false, timeout_ms: 60000 },
});

const bash = (command) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

function parseOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`\u2713 ${name}\n`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    process.stdout.write(`\u2717 ${name}\n`);
  }
}

await test('non-PreToolUse event exits 0 silently', async () => {
  const { code, stdout } = await runHook({
    hook_event_name: 'UserPromptSubmit',
    tool_name: 'Monitor',
    tool_input: {},
  });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

await test('Bash tool is ignored (matcher is Monitor-only)', async () => {
  const { code, stdout } = await runHook(bash('coral-cli wait --timeout=300'));
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

await test('Monitor + bare coral-cli wait → deny', async () => {
  const { stdout } = await runHook(monitor('coral-cli wait --timeout=300'));
  const out = parseOutput(stdout);
  assert.ok(out, 'expected hookSpecificOutput');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('Bash'));
});

await test('Monitor + node <active> wait → deny', async () => {
  const { stdout } = await runHook(monitor(`node '${ACTIVE_BRIDGE}' wait --timeout=60`));
  const out = parseOutput(stdout);
  assert.ok(out, 'expected deny');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

await test('Monitor + log tail (non-coral) passes through', async () => {
  const { code, stdout } = await runHook(monitor('tail -f /var/log/app.log | grep ERROR'));
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

await test('Monitor + coral-cli non-wait subcommand passes through', async () => {
  const { code, stdout } = await runHook(monitor('coral-cli kb search foo'));
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

await test('Monitor + compound containing coral-cli wait → deny', async () => {
  const { stdout } = await runHook(monitor('echo start && coral-cli wait --timeout=30'));
  const out = parseOutput(stdout);
  assert.ok(out, 'expected deny for compound with coral-cli wait');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const { name, err } of failures) {
    process.stderr.write(`\n[${name}]\n${err.stack ?? err.message}\n`);
  }
  process.exit(1);
}
