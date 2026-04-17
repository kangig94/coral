#!/usr/bin/env node
// Standalone smoke tests for hooks/cli-resolve.mjs.
// Run: node hooks/__tests__/cli-resolve.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'cli-resolve.mjs');
const PLUGIN_ROOT = join(HERE, '..', '..');
const ACTIVE_BRIDGE = join(PLUGIN_ROOT, 'bridge', 'coral-cli.cjs');
const BRIDGE_PREFIX = dirname(PLUGIN_ROOT);

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

await test('non-Bash event exits 0 with no output', async () => {
  const { code, stdout } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: {},
  });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

await test('non-coral command passes through silently', async () => {
  const { code, stdout } = await runHook(bash('ls -la'));
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

await test('bare coral-cli is rewritten to node <active-bridge>', async () => {
  const { stdout } = await runHook(bash('coral-cli kb principles'));
  const out = parseOutput(stdout);
  assert.ok(out, 'expected hookSpecificOutput');
  const cmd = out.hookSpecificOutput.updatedInput.command;
  assert.ok(cmd.startsWith(`node '${ACTIVE_BRIDGE}' `), `got: ${cmd}`);
  assert.ok(cmd.endsWith(' kb principles'), `got: ${cmd}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
});

await test('already-active node command: no wait/inline → exit 0 silently', async () => {
  const { stdout } = await runHook(bash(`node '${ACTIVE_BRIDGE}' kb principles`));
  assert.equal(stdout, '');
});

await test('stale bridge path under coral cache prefix is rewritten', async () => {
  const stale = join(BRIDGE_PREFIX, '0.0.0-nonexistent', 'bridge', 'coral-cli.cjs');
  assert.ok(!existsSync(stale), 'test setup: stale path must not exist');
  const { stdout } = await runHook(bash(`node '${stale}' kb principles`));
  const out = parseOutput(stdout);
  assert.ok(out, 'expected rewrite');
  const cmd = out.hookSpecificOutput.updatedInput.command;
  assert.ok(cmd.startsWith(`node '${ACTIVE_BRIDGE}' `), `got: ${cmd}`);
});

await test('external --plugin-dir path outside cache is NOT rewritten', async () => {
  const external = '/tmp/does-not-exist-xyz/bridge/coral-cli.cjs';
  assert.ok(!existsSync(external));
  const { stdout } = await runHook(bash(`node '${external}' kb principles`));
  assert.equal(stdout, '');
});

await test('-i "prompt text" becomes tempfile path', async () => {
  const { stdout } = await runHook(bash('coral-cli codex agent -i "prompt text"'));
  const out = parseOutput(stdout);
  const cmd = out.hookSpecificOutput.updatedInput.command;
  assert.ok(/coral-input-[0-9a-f]+\.txt/.test(cmd), `expected tempfile: ${cmd}`);
});

await test('wait --timeout=300 injects Bash timeout 310000ms', async () => {
  const { stdout } = await runHook(bash('coral-cli wait --timeout=300'));
  const out = parseOutput(stdout);
  assert.equal(out.hookSpecificOutput.updatedInput.timeout, 310_000);
  assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
});

await test('pipe: coral-cli kb principles | grep foo rewrites coral stage only', async () => {
  const { stdout } = await runHook(bash('coral-cli kb principles | grep foo'));
  const out = parseOutput(stdout);
  const cmd = out.hookSpecificOutput.updatedInput.command;
  assert.ok(cmd.includes('| grep foo'), `pipe preserved: ${cmd}`);
  assert.equal((cmd.match(/node '/g) || []).length, 1, `single rewrite: ${cmd}`);
});

await test('&& chain: both coral-cli segments rewritten, separator preserved', async () => {
  const { stdout } = await runHook(bash('coral-cli a && coral-cli b'));
  const out = parseOutput(stdout);
  const cmd = out.hookSpecificOutput.updatedInput.command;
  assert.equal((cmd.match(/node '/g) || []).length, 2, `two rewrites: ${cmd}`);
  assert.ok(cmd.includes(' && '), `&& preserved: ${cmd}`);
});

await test('DQ-contained && is literal; single command rewrite with tempfile', async () => {
  const { stdout } = await runHook(bash('coral-cli codex agent -i "a && b"'));
  const out = parseOutput(stdout);
  const cmd = out.hookSpecificOutput.updatedInput.command;
  assert.equal((cmd.match(/node '/g) || []).length, 1, `single rewrite: ${cmd}`);
  assert.ok(/coral-input-[0-9a-f]+\.txt/.test(cmd), `tempfile created: ${cmd}`);
});

await test('redirection > triggers pass-through (splitter null)', async () => {
  const { stdout } = await runHook(bash('coral-cli foo > out.txt'));
  assert.equal(stdout, '');
});

await test('unquoted backslash triggers pass-through', async () => {
  const { stdout } = await runHook(bash('coral-cli foo \\&\\& bar'));
  assert.equal(stdout, '');
});

await test('idempotency: bare coral-cli → node ... → no further change', async () => {
  const first = await runHook(bash('coral-cli kb principles'));
  const firstOut = parseOutput(first.stdout);
  const firstCmd = firstOut.hookSpecificOutput.updatedInput.command;
  const second = await runHook(bash(firstCmd));
  assert.equal(second.stdout, '', `second pass should be noop, got: ${second.stdout}`);
});

await test('idempotency: stale → active → no further change', async () => {
  const stale = join(BRIDGE_PREFIX, '0.0.0-nonexistent', 'bridge', 'coral-cli.cjs');
  const first = await runHook(bash(`node '${stale}' kb principles`));
  const firstOut = parseOutput(first.stdout);
  const firstCmd = firstOut.hookSpecificOutput.updatedInput.command;
  const second = await runHook(bash(firstCmd));
  assert.equal(second.stdout, '');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const { name, err } of failures) {
    process.stderr.write(`\n[${name}]\n${err.stack ?? err.message}\n`);
  }
  process.exit(1);
}
