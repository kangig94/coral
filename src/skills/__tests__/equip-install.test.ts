import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALL_SCRIPT = join(process.cwd(), 'skills', 'equip', 'install.mjs');
const KB_VERSION = '0.1.0';
const createdRoots: string[] = [];

interface InstallerChoice {
  id: string;
  label: string;
  provider: string | null;
  model: string | null;
  dims: number | null;
}

interface InstallerJson {
  status: string;
  method?: string;
  targetDir?: string;
  postInstall?: string[];
  version?: string;
  onboarding?: {
    envPath?: string;
    requiredEnv?: string[];
    providerEnvKey?: string;
    modelEnvKey?: string;
    apiKeyEnvKey?: string;
    securityNotice?: string;
    localRuntime?: {
      targetDir?: string;
      bootstrapPackageJson?: boolean;
      packageManager?: string;
      packageName?: string;
    };
    choices?: InstallerChoice[];
  };
}

interface Fixture {
  root: string;
  homeDir: string;
  binDir: string;
  logPath: string;
  archivePath: string;
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
    logPath: join(root, 'curl.log'),
    archivePath: join(root, 'prebuild.tar.gz'),
    targetDir: join(root, 'home', '.coral', 'data', 'kb'),
  };

  createdRoots.push(root);
  mkdirSync(fixture.homeDir, { recursive: true });
  mkdirSync(fixture.binDir, { recursive: true });
  return fixture;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf-8');
  chmodSync(path, 0o755);
}

function writeFakeCurl(binDir: string): void {
  writeExecutable(
    join(binDir, 'curl'),
    `#!/bin/sh
echo "$*" >> "$FAKE_CURL_LOG"
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    dest="$2"
    shift 2
    continue
  fi
  shift
done
if [ "\${FAKE_CURL_FAIL:-0}" = "1" ]; then
  echo "forced curl failure" >&2
  exit 1
fi
if [ -z "$dest" ]; then
  echo "missing -o" >&2
  exit 1
fi
cp "$FAKE_CURL_ARCHIVE" "$dest"
`,
  );
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  Buffer.from(encoded, 'utf-8').copy(header, offset, 0, length);
}

function createPrebuildArchive(path: string, fileName: string, content: Buffer): void {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, fileName, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, content.length, 124, 12);
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 'ustar', 257, 6);
  writeTarString(header, '00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarOctal(header, checksum, 148, 8);

  const paddingSize = (512 - (content.length % 512)) % 512;
  const archive = Buffer.concat([
    header,
    content,
    Buffer.alloc(paddingSize, 0),
    Buffer.alloc(1024, 0),
  ]);

  writeFileSync(path, gzipSync(archive));
}

function writeInstalledKb(
  fixture: Fixture,
  version: string = KB_VERSION,
  method: 'prebuild' | 'source-build' = 'prebuild',
): void {
  mkdirSync(join(fixture.targetDir, 'vec'), { recursive: true });
  writeFileSync(join(fixture.targetDir, 'vec', 'coral-needle.node'), Buffer.from('installed-addon'));
  writeFileSync(join(fixture.targetDir, '.kb-meta.json'), JSON.stringify({ version, method }), 'utf-8');
}

function writeGlobalKbMeta(fixture: Fixture, version: string): void {
  const toolsDir = join(fixture.homeDir, '.claude', 'tools');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, '.kb.json'), JSON.stringify({ version, method: 'binary' }), 'utf-8');
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
      FAKE_CURL_LOG: fixture.logPath,
      FAKE_CURL_ARCHIVE: fixture.archivePath,
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
  expect(result.stderr).toBe('');
  const trimmed = result.stdout.trim();
  expect(trimmed).not.toBe('');
  expect(trimmed.split(/\r?\n/)).toHaveLength(1);
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

describe('skills/equip/install.mjs kb addon flow', () => {
  it('installs the KB addon into the runtime vec dir and emits single-line onboarding JSON', () => {
    const fixture = createFixture();
    const addonBytes = Buffer.from('native-addon');
    writeFakeCurl(fixture.binDir);
    createPrebuildArchive(fixture.archivePath, 'coral-needle.node', addonBytes);

    const result = parseResult(runInstall(fixture, ['kb']));

    expect(result).toMatchObject({
      status: 'installed',
      method: 'prebuild',
      targetDir: fixture.targetDir,
      postInstall: ['backend_shutdown', 'kb_reindex'],
      version: KB_VERSION,
      onboarding: {
        envPath: join(fixture.homeDir, '.coral', '.env'),
        requiredEnv: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
        providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
        modelEnvKey: 'CORAL_EMBEDDING_MODEL',
        apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
        securityNotice: 'Store API keys in ~/.coral/.env, not in settings.json.',
        localRuntime: {
          targetDir: fixture.targetDir,
          bootstrapPackageJson: true,
          packageManager: 'npm',
          packageName: 'onnxruntime-node',
        },
      },
    });
    expect(result.onboarding?.choices).toEqual([
      {
        id: 'local-nomic-embed-text',
        label: 'Local model: nomic-embed-text',
        provider: 'local-onnx',
        model: 'nomic-embed-text',
        dims: 768,
      },
      {
        id: 'local-bge-m3',
        label: 'Local model: bge-m3',
        provider: 'local-onnx',
        model: 'bge-m3',
        dims: 1024,
      },
      {
        id: 'manual',
        label: 'Manual setup',
        provider: null,
        model: null,
        dims: null,
      },
    ]);
    expect(readFileSync(join(fixture.targetDir, 'vec', 'coral-needle.node'))).toEqual(addonBytes);
    expect(readJson(join(fixture.targetDir, '.kb-meta.json'))).toEqual({
      version: KB_VERSION,
      method: 'prebuild',
    });
    const [curlCall] = readLog(fixture.logPath);
    expect(curlCall).toContain('-fsSL -o');
    expect(curlCall).toContain(
      `https://github.com/kangig94/coral-needle/releases/download/v${KB_VERSION}/coral-needle-v${KB_VERSION}-${process.platform}-${process.arch}.tar.gz`,
    );
  });

  it('uses runtime-local addon metadata for already_installed instead of ~/.claude/tools metadata', () => {
    const fixture = createFixture();
    writeGlobalKbMeta(fixture, '999.0.0');
    writeInstalledKb(fixture, KB_VERSION, 'source-build');

    const result = parseResult(runInstall(fixture, ['kb']));

    expect(result).toMatchObject({
      status: 'already_installed',
      method: 'source-build',
      targetDir: fixture.targetDir,
      postInstall: ['backend_shutdown', 'kb_reindex'],
      version: KB_VERSION,
      onboarding: {
        localRuntime: {
          targetDir: fixture.targetDir,
        },
      },
    });
    expect(readLog(fixture.logPath)).toEqual([]);
  });

  it('returns already_up_to_date when the runtime-local addon already matches the packaged needleVersion', () => {
    const fixture = createFixture();
    writeInstalledKb(fixture, KB_VERSION, 'prebuild');

    const result = parseResult(runInstall(fixture, ['--update', 'kb']));

    expect(result).toMatchObject({
      status: 'already_up_to_date',
      method: 'prebuild',
      targetDir: fixture.targetDir,
      postInstall: ['backend_shutdown', 'kb_reindex'],
      version: KB_VERSION,
    });
    expect(readLog(fixture.logPath)).toEqual([]);
  });
});
