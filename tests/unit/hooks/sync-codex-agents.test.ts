import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupFixtures, createFixture, runHook } from '#tests/unit/hooks/_helpers.js';

const hook = join(process.cwd(), 'clients', 'hooks', 'sync-codex-agents.mjs');

function setup() {
  const fixture = createFixture();
  const source = join(fixture.pluginRoot, 'agents');
  const codexHome = join(fixture.root, 'codex');
  mkdirSync(source, { recursive: true });
  return {
    source,
    codexHome,
    agentsDir: join(codexHome, 'agents'),
    run: (overrides: Record<string, string | undefined> = {}) =>
      runHook(
        hook,
        { hook_event_name: 'SessionStart', source: 'startup' },
        {
          HOME: fixture.root,
          CODEX_HOME: codexHome,
          PLUGIN_ROOT: fixture.pluginRoot,
          CORAL_FLAVOR: undefined,
          ...overrides,
        },
      ),
  };
}

afterEach(cleanupFixtures);

describe('sync-codex-agents.mjs', () => {
  it('installs a namespaced TOML, skips identical content, and replaces a changed managed definition', () => {
    const { source, agentsDir, run } = setup();
    const definition = join(source, 'pioneer.md');
    const installed = join(agentsDir, 'coral-pioneer.toml');
    const markdown = (body: string) =>
      `---\nname: pioneer\ndescription: "Finds elegant designs."\nmodel: fable\n---\n${body}\n`;
    writeFileSync(definition, markdown('Review the "design".\nReturn alternatives.'));

    const firstRun = run();
    expect(firstRun.status).toBe(0);
    expect(firstRun.stdout).toContain('Open a new thread');
    expect(parse(readFileSync(installed, 'utf8'))).toEqual({
      name: 'coral:pioneer',
      description: 'Finds elegant designs.',
      developer_instructions: 'Review the "design".\nReturn alternatives.',
    });

    const previous = statSync(installed);
    expect(run().stdout).toBe('');
    expect(statSync(installed).ino).toBe(previous.ino);

    writeFileSync(definition, markdown('Return ranked alternatives.').replace('name: pioneer', 'name: design-pioneer'));
    expect(run().stdout).toContain('Open a new thread');
    expect(parse(readFileSync(installed, 'utf8'))).toMatchObject({
      name: 'coral:design-pioneer',
      developer_instructions: 'Return ranked alternatives.',
    });
  });

  it('preserves existing user files and symlinks while syncing other agents in the default home', () => {
    const { source, codexHome, run } = setup();
    const home = join(codexHome, 'user-home');
    const agentsDir = join(home, '.codex', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const privateFile = join(agentsDir, 'coral-pioneer.toml');
    const symlink = join(agentsDir, 'coral-critic.toml');
    writeFileSync(privateFile, 'name = "personal"\n');
    symlinkSync(privateFile, symlink);
    for (const agent of ['pioneer', 'critic', 'architect']) {
      writeFileSync(
        join(source, `${agent}.md`),
        `---\nname: ${agent}\ndescription: '${agent}''s purpose'\n---\nReview files.\n`,
      );
    }

    expect(run({ HOME: home, CODEX_HOME: undefined }).status).toBe(0);
    expect(readFileSync(privateFile, 'utf8')).toBe('name = "personal"\n');
    expect(readFileSync(symlink, 'utf8')).toBe('name = "personal"\n');
    expect(existsSync(join(codexHome, 'agents'))).toBe(false);
    expect(parse(readFileSync(join(agentsDir, 'coral-architect.toml'), 'utf8')).description).toBe(
      "architect's purpose",
    );
  });
});
