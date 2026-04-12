import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const createdRoots: string[] = [];

function createHookUtilsFixture(flavor: 'prod' | 'dev'): {
  root: string;
  manifestPath: string;
  modulePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-hook-utils-'));
  const modulePath = join(root, 'hooks', 'lib', 'hook-utils.mjs');
  const manifestPath = join(root, 'bridge', 'manifest.json');

  createdRoots.push(root);
  mkdirSync(join(root, 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(root, 'bridge'), { recursive: true });
  writeFileSync(modulePath, readFileSync(join(process.cwd(), 'hooks', 'lib', 'hook-utils.mjs'), 'utf-8'), 'utf-8');
  writeFileSync(manifestPath, JSON.stringify({ bundleHash: 'test-hash', flavor }), 'utf-8');

  return { root, manifestPath, modulePath };
}

function runHookUtilsModule(
  modulePath: string,
  script: string,
  envOverrides: Record<string, string | undefined> = {},
): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }

  const result = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `const mod = await import(${JSON.stringify(pathToFileURL(modulePath).href)});\n${script}`,
    ],
    {
      encoding: 'utf-8',
      env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
  };
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('hook-utils flavor gating', () => {
  it('caches buildFlavor from its own manifest path', () => {
    const fixture = createHookUtilsFixture('dev');

    const result = runHookUtilsModule(
      fixture.modulePath,
      [
        "const { writeFileSync } = await import('node:fs');",
        'console.log(mod.buildFlavor());',
        `writeFileSync(${JSON.stringify(fixture.manifestPath)}, JSON.stringify({ bundleHash: 'test-hash', flavor: 'prod' }));`,
        'console.log(mod.buildFlavor());',
      ].join('\n'),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['dev', 'dev']);
  });

  it.each([
    {
      name: 'continues when CORAL_FLAVOR=prod matches a prod manifest',
      manifestFlavor: 'prod' as const,
      coralFlavor: 'prod',
      stdout: 'after',
    },
    {
      name: 'exits cleanly when CORAL_FLAVOR=dev gates a prod manifest',
      manifestFlavor: 'prod' as const,
      coralFlavor: 'dev',
      stdout: '',
    },
    {
      name: 'exits cleanly when CORAL_FLAVOR=prod gates a dev manifest',
      manifestFlavor: 'dev' as const,
      coralFlavor: 'prod',
      stdout: '',
    },
    {
      name: 'continues when CORAL_FLAVOR=dev matches a dev manifest',
      manifestFlavor: 'dev' as const,
      coralFlavor: 'dev',
      stdout: 'after',
    },
  ])('$name', ({ manifestFlavor, coralFlavor, stdout }) => {
    const fixture = createHookUtilsFixture(manifestFlavor);

    const result = runHookUtilsModule(
      fixture.modulePath,
      [
        'mod.exitIfWrongFlavor();',
        "console.log('after');",
      ].join('\n'),
      { CORAL_FLAVOR: coralFlavor },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(stdout);
    expect(result.stderr.trim()).toBe('');
  });

  it('treats an unset CORAL_FLAVOR as prod', () => {
    const fixture = createHookUtilsFixture('prod');

    const result = runHookUtilsModule(
      fixture.modulePath,
      [
        'mod.exitIfWrongFlavor();',
        "console.log('after');",
      ].join('\n'),
      { CORAL_FLAVOR: undefined },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('after');
  });

  it('exits cleanly on manifest mismatch after defaulting an unset CORAL_FLAVOR to prod', () => {
    const fixture = createHookUtilsFixture('dev');

    const result = runHookUtilsModule(
      fixture.modulePath,
      [
        'mod.exitIfWrongFlavor();',
        "console.log('after');",
      ].join('\n'),
      { CORAL_FLAVOR: undefined },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('rejects unrecognized CORAL_FLAVOR values', () => {
    const fixture = createHookUtilsFixture('prod');

    const result = runHookUtilsModule(
      fixture.modulePath,
      [
        'mod.exitIfWrongFlavor();',
        "console.log('after');",
      ].join('\n'),
      { CORAL_FLAVOR: 'staging' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).toContain("[coral] CORAL_FLAVOR='staging' is not recognized");
  });
});

describe('hook-utils KB root resolution', () => {
  it('uses flavor-aware defaults when CORAL_KB_PATH is unset', () => {
    const prodFixture = createHookUtilsFixture('prod');
    const devFixture = createHookUtilsFixture('dev');

    const prodResult = runHookUtilsModule(
      prodFixture.modulePath,
      'console.log(mod.resolveKbRoot());',
      { HOME: prodFixture.root, CORAL_KB_PATH: undefined },
    );
    const devResult = runHookUtilsModule(
      devFixture.modulePath,
      'console.log(mod.resolveKbRoot());',
      { HOME: devFixture.root, CORAL_KB_PATH: undefined },
    );

    expect(prodResult.status).toBe(0);
    expect(devResult.status).toBe(0);
    expect(prodResult.stdout.trim()).toBe(join(prodFixture.root, '.coral', 'kb'));
    expect(devResult.stdout.trim()).toBe(join(devFixture.root, '.coral', 'kb-dev'));
  });

  it('keeps CORAL_KB_PATH as the markdown root override', () => {
    const fixture = createHookUtilsFixture('dev');

    const result = runHookUtilsModule(
      fixture.modulePath,
      'console.log(mod.resolveKbRoot());',
      {
        HOME: fixture.root,
        CORAL_KB_PATH: '~/custom-kb',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(fixture.root, 'custom-kb'));
  });
});
