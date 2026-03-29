import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALL_SCRIPT = join(process.cwd(), 'skills', 'equip', 'install.mjs');
const createdRoots: string[] = [];

interface InstallerJson {
  status: string;
  method?: string;
  targetDir?: string;
  postInstall?: string[];
  version?: string;
}

interface Fixture {
  root: string;
  homeDir: string;
  binDir: string;
  logPath: string;
  targetDir: string;
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coral-equip-install-')));
  const fixture = {
    root,
    homeDir: join(root, 'home'),
    binDir: join(root, 'bin'),
    logPath: join(root, 'npm.log'),
    targetDir: join(root, 'home', '.coral', 'data', 'kb'),
  };

  createdRoots.push(root);
  mkdirSync(fixture.homeDir, { recursive: true });
  mkdirSync(fixture.binDir, { recursive: true });
  return fixture;
}

function writeFakeNpm(binDir: string): void {
  const fakeNpm = join(binDir, 'npm');
  writeFileSync(fakeNpm, `#!/bin/sh
echo "$PWD|$*" >> "$FAKE_NPM_LOG"
if [ "$1" = "view" ] && [ "$2" = "@lancedb/lancedb" ] && [ "$3" = "version" ]; then
  printf '%s\\n' "\${FAKE_NPM_VIEW_VERSION:-0.0.0}"
  exit 0
fi
if [ "$1" = "init" ] && [ "$2" = "-y" ]; then
  printf '{"name":"kb-runtime","version":"1.0.0"}\\n' > "$PWD/package.json"
  exit 0
fi
if [ "$1" = "install" ]; then
  version="\${2##*@}"
  mkdir -p "$PWD/node_modules/@lancedb/lancedb"
  printf '{"name":"@lancedb/lancedb","version":"%s"}\\n' "$version" > "$PWD/node_modules/@lancedb/lancedb/package.json"
  exit 0
fi
echo "unexpected npm args: $*" >&2
exit 1
`, 'utf-8');
  chmodSync(fakeNpm, 0o755);
}

function runInstall(
  fixture: Fixture,
  args: string[],
  envOverrides: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: fixture.homeDir,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
      FAKE_NPM_LOG: fixture.logPath,
      ...envOverrides,
    },
    timeout: 5000,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function parseResult(result: { stdout: string; stderr: string; status: number }): InstallerJson {
  expect(result.status).toBe(0);
  const trimmed = result.stdout.trim();
  expect(trimmed).not.toBe('');
  return JSON.parse(trimmed) as InstallerJson;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function readLog(path: string): string[] {
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function writeInstalledKb(fixture: Fixture, version: string): void {
  mkdirSync(join(fixture.targetDir, 'node_modules', '@lancedb', 'lancedb'), { recursive: true });
  writeFileSync(
    join(fixture.targetDir, 'node_modules', '@lancedb', 'lancedb', 'package.json'),
    JSON.stringify({ name: '@lancedb/lancedb', version }),
    'utf-8',
  );
}

function writeGlobalKbMeta(fixture: Fixture, version: string): void {
  const toolsDir = join(fixture.homeDir, '.claude', 'tools');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, '.kb.json'), JSON.stringify({ version, method: 'binary' }), 'utf-8');
}

describe('skills/equip/install.mjs kb local-npm flow', () => {
  it('installs kb into the runtime dir with a pinned npm version and local metadata', () => {
    const fixture = createFixture();
    writeFakeNpm(fixture.binDir);

    const result = parseResult(runInstall(fixture, ['kb'], { FAKE_NPM_VIEW_VERSION: '0.9.9' }));

    expect(result).toEqual({
      status: 'installed',
      method: 'local-npm',
      targetDir: fixture.targetDir,
      postInstall: ['backend_shutdown', 'kb_reindex'],
      version: '0.9.9',
    });
    expect(readJson(join(fixture.targetDir, '.kb-meta.json'))).toEqual({
      version: '0.9.9',
      method: 'local-npm',
    });
    expect(readJson(join(fixture.targetDir, 'node_modules', '@lancedb', 'lancedb', 'package.json'))).toEqual({
      name: '@lancedb/lancedb',
      version: '0.9.9',
    });
    expect(readLog(fixture.logPath)).toEqual([
      `${process.cwd()}|view @lancedb/lancedb version`,
      `${fixture.targetDir}|init -y`,
      `${fixture.targetDir}|install @lancedb/lancedb@0.9.9`,
    ]);
  });

  it('uses targetDir-local package inspection for already_installed instead of ~/.claude/tools metadata', () => {
    const fixture = createFixture();
    writeFakeNpm(fixture.binDir);
    writeInstalledKb(fixture, '0.8.0');
    writeGlobalKbMeta(fixture, '999.0.0');

    const result = parseResult(runInstall(fixture, ['kb@0.8.0']));

    expect(result).toEqual({
      status: 'already_installed',
      method: 'local-npm',
      targetDir: fixture.targetDir,
      postInstall: ['backend_shutdown', 'kb_reindex'],
      version: '0.8.0',
    });
    expect(readJson(join(fixture.targetDir, '.kb-meta.json'))).toEqual({
      version: '0.8.0',
      method: 'local-npm',
    });
    expect(readLog(fixture.logPath)).toEqual([]);
  });

  it('updates kb from the targetDir-local state even when global metadata claims the target version', () => {
    const fixture = createFixture();
    writeFakeNpm(fixture.binDir);
    writeInstalledKb(fixture, '0.1.0');
    writeGlobalKbMeta(fixture, '0.2.0');

    const result = parseResult(runInstall(fixture, ['--update', 'kb@0.2.0']));

    expect(result).toEqual({
      status: 'updated',
      method: 'local-npm',
      targetDir: fixture.targetDir,
      postInstall: ['backend_shutdown', 'kb_reindex'],
      version: '0.2.0',
    });
    expect(readJson(join(fixture.targetDir, '.kb-meta.json'))).toEqual({
      version: '0.2.0',
      method: 'local-npm',
    });
    expect(readJson(join(fixture.targetDir, 'node_modules', '@lancedb', 'lancedb', 'package.json'))).toEqual({
      name: '@lancedb/lancedb',
      version: '0.2.0',
    });
    expect(readLog(fixture.logPath)).toContain(`${fixture.targetDir}|install @lancedb/lancedb@0.2.0`);
  });

  it('returns already_up_to_date when the targetDir-local package already matches the requested version', () => {
    const fixture = createFixture();
    writeFakeNpm(fixture.binDir);
    writeInstalledKb(fixture, '1.2.3');

    const result = parseResult(runInstall(fixture, ['--update', 'kb@1.2.3']));

    expect(result).toEqual({
      status: 'already_up_to_date',
      method: 'local-npm',
      targetDir: fixture.targetDir,
      postInstall: ['backend_shutdown', 'kb_reindex'],
      version: '1.2.3',
    });
    expect(readJson(join(fixture.targetDir, '.kb-meta.json'))).toEqual({
      version: '1.2.3',
      method: 'local-npm',
    });
    expect(readLog(fixture.logPath)).toEqual([]);
  });
});
