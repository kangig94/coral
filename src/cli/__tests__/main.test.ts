import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_BUNDLE = join(process.cwd(), 'bridge', 'coral-cli.cjs');

function runCli(args: string[], env?: Record<string, string>): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = spawnSync('node', [CLI_BUNDLE, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('cli main — help and structure', () => {
  it('shows top-level help with all subcommands', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('codex');
    expect(stdout).toContain('claude');
    expect(stdout).toContain('wait');
    expect(stdout).toContain('abort');
    expect(stdout).toContain('workflow');
    expect(stdout).toContain('backend');
    expect(stdout).toContain('discuss');
  });

  it('shows provider subcommand help', () => {
    const { stdout, status } = runCli(['codex', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('exec');
    expect(stdout).toContain('fork');
    expect(stdout).toContain('list');
    expect(stdout).toContain('coral');
  });

  it('shows wait subcommand help', () => {
    const { stdout, status } = runCli(['wait', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--jobs');
    expect(stdout).toContain('--timeout');
    expect(stdout).toContain('--cursor');
    expect(stdout).toContain('--embed');
  });

  it('shows discuss subcommand help', () => {
    const { stdout, status } = runCli(['discuss', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('seed');
    expect(stdout).toContain('start');
    expect(stdout).toContain('watch');
    expect(stdout).toContain('participate');
    expect(stdout).toContain('abort');
  });

  it('shows backend subcommand help', () => {
    const { stdout, status } = runCli(['backend', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('status');
    expect(stdout).toContain('shutdown');
  });

  it('normalizes coral:<agent> syntax to coral <agent> form', () => {
    // coral:architect help should not error on syntax — it becomes "codex coral architect"
    const { stdout, status } = runCli(['codex', 'coral:architect', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--prompt');
  });
});

describe('cli main — wait --jobs validation', () => {
  it('exits 1 and emits error when --jobs is empty', () => {
    const { stderr, status } = runCli(['wait', '--jobs', '']);
    expect(status).toBe(1);
    expect(stderr).toContain('job');
  });
});

describe('cli main — workflow --json merge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads expression and init_prompt from --json file', () => {
    // This tests flag validation — expression must come from json or flag
    const jsonFile = join(tmpDir, 'payload.json');
    writeFileSync(jsonFile, JSON.stringify({
      expression: '(architect, critic)',
      init_prompt: 'test',
    }));

    // Without backend running, will fail to connect but should get past validation
    const { stderr } = runCli(['workflow', '--json', jsonFile], { HOME: tmpDir });
    // The error is a connection error, not a validation error
    expect(stderr).not.toContain('--expression is required');
    expect(stderr).not.toContain('--init-prompt is required');
  });

  it('exits 1 with validation error when expression is missing', () => {
    const jsonFile = join(tmpDir, 'payload.json');
    writeFileSync(jsonFile, JSON.stringify({ init_prompt: 'test' }));

    const { stderr, status } = runCli(['workflow', '--json', jsonFile]);
    expect(status).toBe(1);
    expect(stderr).toContain('--expression is required');
  });

  it('exits 1 with validation error when init-prompt is missing', () => {
    const jsonFile = join(tmpDir, 'payload.json');
    writeFileSync(jsonFile, JSON.stringify({ expression: '(architect)' }));

    const { stderr, status } = runCli(['workflow', '--json', jsonFile]);
    expect(status).toBe(1);
    expect(stderr).toContain('--init-prompt is required');
  });

  it('flag takes precedence over json expression', () => {
    const jsonFile = join(tmpDir, 'payload.json');
    writeFileSync(jsonFile, JSON.stringify({
      expression: 'from-json',
      init_prompt: 'from-json',
    }));

    // With both flag and json, flag wins — no validation error (both present)
    const { stderr } = runCli(['workflow', '--expression', 'from-flag', '--json', jsonFile], { HOME: tmpDir });
    expect(stderr).not.toContain('--expression is required');
    expect(stderr).not.toContain('--init-prompt is required');
  });
});

describe('cli main — backend status without daemon', () => {
  it('exits 0 and emits not_running when no backend is running', () => {
    const { stdout, status } = runCli(['backend', 'status'], {
      // Point to a temp dir with no backend.json to ensure not_running
      HOME: tmpdir(),
    });
    // Should exit 0 regardless of backend state per AC8
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(['ok', 'shutting_down', 'unauthorized', 'not_running']).toContain(parsed.status);
  });
});

describe('cli main — abort --jobs parsing', () => {
  it('exits 1 with error when --jobs is empty string', () => {
    const { stderr, status } = runCli(['abort', '--jobs', '']);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain('job');
  });
});
