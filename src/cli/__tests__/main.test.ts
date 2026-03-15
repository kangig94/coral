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
    const { stdout, status } = runCli(['codex', 'coral:architect', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--prompt');
  });
});

describe('cli main — output format', () => {
  it('rejects invalid --output-format values before command execution', () => {
    const { stderr, status } = runCli(['backend', 'status', '--output-format', 'yaml']);
    expect(status).toBe(1);
    expect(stderr).toContain('output-format');
    expect(stderr).toContain('text');
    expect(stderr).toContain('json');
  });
});

describe('cli main — wait --jobs validation', () => {
  it('exits 1 and emits error when --jobs is empty', () => {
    const { stderr, status } = runCli(['wait', '--jobs', '']);
    expect(status).toBe(1);
    expect(stderr).toContain('job');
  });
});

describe('cli main — workflow --input-json merge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads expression and init_prompt from --input-json stdin', () => {
    const { stderr } = runCli(
      ['workflow', '--input-json', '-', '--detach'],
      {
        env: { HOME: tmpDir },
        input: JSON.stringify({
          expression: '(architect, critic)',
          init_prompt: 'test',
        }),
      },
    );

    expect(stderr).not.toContain('--expression is required');
    expect(stderr).not.toContain('--init-prompt is required');
  });

  it('exits 1 with validation error when expression is missing', () => {
    const { stderr, status } = runCli(
      ['workflow', '--input-json', '-'],
      {
        input: JSON.stringify({ init_prompt: 'test' }),
      },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('--expression is required');
  });

  it('exits 1 with validation error when init-prompt is missing', () => {
    const { stderr, status } = runCli(
      ['workflow', '--input-json', '-'],
      {
        input: JSON.stringify({ expression: '(architect)' }),
      },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('--init-prompt is required');
  });

  it('accepts explicit flags alongside --input-json stdin', () => {
    const { stderr } = runCli(
      ['workflow', '--expression', 'from-flag', '--input-json', '-', '--detach'],
      {
        env: { HOME: tmpDir },
        input: JSON.stringify({
          expression: 'from-json',
          init_prompt: 'from-json',
        }),
      },
    );

    expect(stderr).not.toContain('--expression is required');
    expect(stderr).not.toContain('--init-prompt is required');
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
    const { stderr } = runCli(
      ['discuss', 'seed', '--input-json', '-'],
      {
        env: { HOME: tmpDir },
        input: JSON.stringify({
          controversy_axes: [{ axis: 'risk', positions: ['low', 'high'] }],
          n: 2,
          seed: 1,
        }),
      },
    );

    expect(stderr).not.toContain('controversy_axes');
    expect(stderr).not.toContain('Array must contain at least 1 element(s)');
  });

  it('accepts discuss start payload from --input-json stdin', () => {
    const { stderr } = runCli(
      ['discuss', 'start', '--input-json', '-'],
      {
        input: JSON.stringify({
          agents: [
            { name: 'alice', persona: 'One' },
          ],
        }),
      },
    );

    expect(stderr).not.toContain("required option '--json <file>'");
    expect(stderr).toContain('Array must contain at least 2 element(s)');
  });

  it('collects repeated --agent flags for discuss start', () => {
    const { stderr } = runCli(
      [
        'discuss',
        'start',
        '--agent',
        'name=alice,persona=One',
        '--agent',
        'name=bob,persona=Two',
      ],
    );

    expect(stderr).not.toContain('Array must contain at least 2 element(s)');
    expect(stderr).toContain('Required');
  });

  it('accepts discuss participate payload from --input-json stdin', () => {
    const { stderr } = runCli(
      ['discuss', 'participate', '--input-json', '-'],
      {
        env: { HOME: tmpDir },
        input: JSON.stringify({
          session: 'session-1',
          agent_name: 'alice',
          score: 42,
          thought: 'I should speak now.',
        }),
      },
    );

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
    expect(stdout.trim()).toBe('Backend not running');
  });

  it('emits json output when --output-format json is passed after the subcommand', () => {
    const { stdout, status } = runCli(['backend', 'status', '--output-format', 'json'], {
      env: { HOME: tmpDir },
    });

    expect(status).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ status: 'not_running' });
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

  it('keeps failure output on stderr in json mode', () => {
    const { stdout, stderr, status } = runCli(['backend', 'shutdown', '--output-format', 'json'], {
      env: { HOME: tmpDir },
    });

    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({ ok: false, reason: 'not_running' });
  });
});

describe('cli main — abort --jobs parsing', () => {
  it('emits json errors when requested', () => {
    const { stderr, status } = runCli(['abort', '--jobs', '', '--output-format', 'json']);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain('job');
  });
});
