import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const base = mkdtempSync('/tmp/hook-fixture-');
const home = join(base, 'home');
const root = join(base, 'plugin');
const runDir = join(home, '.coral', 'gen2', 'run');
mkdirSync(runDir, { recursive: true });
mkdirSync(join(root, 'bridge'), { recursive: true });
mkdirSync(join(root, 'inject'), { recursive: true });
for (const name of ['core.md', 'tools.md', 'cli.md', 'orchestrator.md']) writeFileSync(join(root, 'inject', name), '');
// The external launcher is stubbed so this probe never contacts a real coordinator.
writeFileSync(join(root, 'bridge', 'coral-sentinel.cjs'), 'process.exit(0);\n');
writeFileSync(
  join(runDir, 'startup-diagnostic.json'),
  JSON.stringify({
    schemaVersion: 1,
    state: 'stopped_with_diagnostic',
    retryable: false,
    recordedAt: new Date().toISOString(),
    error: {
      kind: 'coral_setup_error',
      code: 'handoff_shutdown_capability_rejected',
      message: 'Earlier upgrade could not authenticate',
      remediation: 'Automatic retry',
    },
  }),
);
assert.equal(existsSync(join(runDir, 'coordinator.json')), false);
const result = spawnSync(process.execPath, [process.argv[2]], {
  env: {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    CLAUDE_PLUGIN_ROOT: root,
    CORAL_WORK_ROOT_OVERRIDE: join(base, 'work'),
  },
  input: JSON.stringify({ session_id: 'probe-session' }),
  encoding: 'utf8',
});
console.log('hook exit:', result.status);
console.log('hook output:', result.stdout);
assert.equal(result.status, 0, result.stderr);
assert.ok(result.stdout, 'Hook must have produced output');
const output = JSON.parse(result.stdout);
const context = output.hookSpecificOutput.additionalContext;
console.log('coordinator record exists:', existsSync(join(runDir, 'coordinator.json')));
assert.match(context, /deferred its upgrade/, 'Fixture must reach the deferred-upgrade branch');
assert.doesNotMatch(
  context,
  /incumbent continues serving/,
  'A historical refusal must not claim present service when no incumbent is observed',
);

writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify({ pid: process.pid }));
const observed = spawnSync(process.execPath, [process.argv[2]], {
  env: {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    CLAUDE_PLUGIN_ROOT: root,
    CORAL_WORK_ROOT_OVERRIDE: join(base, 'work'),
  },
  input: JSON.stringify({ session_id: 'probe-session' }),
  encoding: 'utf8',
});
assert.equal(observed.status, 0, observed.stderr);
assert.match(JSON.parse(observed.stdout).hookSpecificOutput.additionalContext, /process was observed alive/);
writeFileSync(join(runDir, 'startup-diagnostic.json'), '{invalid');
const malformed = spawnSync(process.execPath, [process.argv[2]], {
  env: {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    CLAUDE_PLUGIN_ROOT: root,
    CORAL_WORK_ROOT_OVERRIDE: join(base, 'work'),
  },
  input: JSON.stringify({ session_id: 'probe-session' }),
  encoding: 'utf8',
});
assert.equal(malformed.status, 0, 'Malformed diagnostics remain fail-open');
console.log('Observed-process and malformed-diagnostic controls passed');
rmSync(base, { recursive: true, force: true });
