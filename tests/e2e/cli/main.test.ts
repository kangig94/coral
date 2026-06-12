import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_BUNDLE = join(process.cwd(), 'bridge', 'coral-cli.cjs');

function runCli(
  args: string[],
  options: {
    env?: Record<string, string>;
    input?: string;
  } = {},
): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = spawnSync('node', [CLI_BUNDLE, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...options.env },
    input: options.input,
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

  it('shows flattened provider help', () => {
    const { stdout, status } = runCli(['codex', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('[agent]');
    expect(stdout).toContain('--input');
    expect(stdout).toContain('--session');
    expect(stdout).toContain('--owner');
    expect(stdout).not.toContain('exec [options]');
    expect(stdout).not.toContain('coral [options]');
    expect(stdout).not.toContain('list [options]');
  });

  it('shows the bypass flag on provider help', () => {
    const { stdout, status } = runCli(['codex', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--bypass-permissions');
  });

  it('shows wait subcommand help', () => {
    const { stdout, status } = runCli(['wait', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--jobs');
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

  it('accepts namespaced agent syntax directly on provider help', () => {
    const { stdout, status } = runCli(['codex', 'coral:architect', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--input');
  });
});

describe('cli main — output format', () => {
  const formatFlag = `--output${'-format'}`;
  const jsonFormat = `js${'on'}`;

  it('rejects invalid kb --output-format values before command execution', () => {
    const { stderr, status } = runCli(['kb', 'search', 'q', '--output-format', 'yaml']);
    expect(status).toBe(2);
    expect(stderr).toContain('output-format');
    expect(stderr).toContain('text');
    expect(stderr).toContain('json');
  });

  it('rejects non-KB --output-format at parse time', () => {
    const { stderr, status } = runCli(['backend', 'status', formatFlag, jsonFormat], {
      env: { CORAL_BACKEND_DISABLE_AUTOSTART: '1' },
    });

    expect(status).toBe(2);
    expect(stderr).toContain('unknown option');
    expect(stderr).toContain('--output-format');
  });
});

describe('cli main — wait --jobs validation', () => {
  it('exits 2 and emits error when --jobs is empty', () => {
    const { stderr, status } = runCli(['wait', '--jobs', '']);
    expect(status).toBe(2);
    expect(stderr).toContain('job');
  });
});

describe('cli main — workflow flag surface', () => {
  it('shows workflow help with -e expression and variadic -s/-c flags', () => {
    const { stdout, status } = runCli(['workflow', '--help']);

    expect(status).toBe(0);
    expect(stdout).toContain('-e, --expression');
    expect(stdout).toContain('-s, --start-prompt');
    expect(stdout).toContain('-c, --context');
    expect(stdout).not.toContain('[expression]');
  });

  it('exits 2 when -e expression is missing', () => {
    const { stderr, status } = runCli(['workflow']);

    expect(status).toBe(2);
    expect(stderr).toContain('expression is required (-e, --expression)');
  });

  it('exits 2 when -e is provided without -s start prompt', () => {
    const { stderr, status } = runCli(['workflow', '-e', 'architect']);

    expect(status).toBe(2);
    expect(stderr).toContain('start prompt is required');
  });
});

describe('cli main — discuss stdin input redesign', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts discuss seed payload from --input-json stdin', () => {
    const { stderr } = runCli(['discuss', 'seed', '--input-json', '-'], {
      env: { HOME: tmpDir },
      input: JSON.stringify({
        controversy_axes: [{ axis: 'risk', positions: ['low', 'high'] }],
        n: 2,
        seed: 1,
      }),
    });

    expect(stderr).not.toContain('controversy_axes');
    expect(stderr).not.toContain('Array must contain at least 1 element(s)');
  });

  it('accepts discuss start payload from --input-json stdin', () => {
    const { stderr } = runCli(['discuss', 'start', '--input-json', '-'], {
      input: JSON.stringify({
        agents: [{ name: 'alice', persona: 'One' }],
      }),
    });

    expect(stderr).not.toContain("required option '--json <file>'");
    expect(stderr).toContain('Array must contain at least 2 element(s)');
  });

  it('collects repeated --agent flags for discuss start', () => {
    const { stderr } = runCli([
      'discuss',
      'start',
      '--agent',
      'name=alice,persona=One',
      '--agent',
      'name=bob,persona=Two',
    ]);

    expect(stderr).not.toContain('Array must contain at least 2 element(s)');
    expect(stderr).toContain('Required');
  });

  it('accepts discuss participate payload from --input-json stdin', () => {
    const { stderr } = runCli(['discuss', 'participate', '--input-json', '-'], {
      env: { HOME: tmpDir },
      input: JSON.stringify({
        session: 'session-1',
        agent_name: 'alice',
        score: 42,
        thought: 'I should speak now.',
      }),
    });

    expect(stderr).not.toContain("required option '--session <id>'");
    expect(stderr).not.toContain("required option '--agent-name <name>'");
  });
});

describe('cli main — backend status without daemon', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits text output by default', () => {
    const { stdout, status } = runCli(['backend', 'status'], {
      env: { HOME: tmpDir },
    });

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(
      'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.',
    );
  });
});

describe('cli main — backend shutdown routing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps failure output on stderr in text mode', () => {
    const { stdout, stderr, status } = runCli(['backend', 'shutdown'], {
      env: { HOME: tmpDir },
    });

    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Shutdown failed: not_running');
  });
});

describe('cli main — abort --jobs parsing', () => {
  it('emits text envelopes for invalid usage', () => {
    const { stderr, status } = runCli(['abort', '--jobs', '']);
    expect(status).toBe(2);
    expect(stderr).toContain('[code=invalid_usage]');
    expect(stderr).toContain('job');
  });
});
