import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { renderInject } from '../../../clients/hooks/lib/inject-render.mjs';

const TEMPLATE = '# Tools\n\nCLI: `{{CORAL_CLI}}`{{EQUIPPED_TOOLS}}\n\ndone';
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type InjectFragments = {
  core?: string;
  tools?: string;
  kbCommon?: string;
  kbOrchestrator?: string;
  kbSession?: string;
};

function pluginRootWith(input: string | InjectFragments): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-inject-render-'));
  createdRoots.push(root);
  const fragments: InjectFragments = typeof input === 'string' ? { core: input } : input;
  const injectRoot = join(root, 'inject');
  mkdirSync(join(injectRoot, 'kb'), { recursive: true });
  for (const [relativePath, content] of [
    ['core.md', fragments.core],
    ['tools.md', fragments.tools],
    ['kb/common.md', fragments.kbCommon],
    ['kb/orchestrator.md', fragments.kbOrchestrator],
    ['kb/session.md', fragments.kbSession],
  ] as const) {
    writeFileSync(join(injectRoot, relativePath), content ?? '', 'utf-8');
  }
  return root;
}

describe('renderInject fragment composition', () => {
  it.each([
    {
      name: 'owner session',
      asOwner: true,
      kbEnabled: true,
      expected: ['core', 'tools', 'kb common', 'orchestrator', 'session'],
    },
    {
      name: 'subagent session',
      asOwner: false,
      kbEnabled: true,
      expected: ['core', 'tools', 'kb common', 'session'],
    },
    { name: 'KB-disabled session', asOwner: true, kbEnabled: false, expected: ['core', 'tools'] },
  ])('composes the $name fragment set in order', ({ asOwner, kbEnabled, expected }) => {
    const out = renderInject({
      pluginRoot: pluginRootWith({
        core: 'core',
        tools: 'tools',
        kbCommon: 'kb common',
        kbOrchestrator: 'orchestrator',
        kbSession: 'session',
      }),
      projectDir: undefined,
      sessionId: 's',
      asOwner,
      kbEnabled,
    });

    expect(out).toBe(expected.join('\n\n'));
  });

  it('renders the shipped fragment bundle without legacy control markers', () => {
    const out = renderInject({
      pluginRoot: join(process.cwd(), 'clients'),
      projectDir: undefined,
      sessionId: 's',
      asOwner: true,
      kbEnabled: true,
    });

    expect(out).toContain('# Coral Guidelines');
    expect(out).toContain('# Tools');
    expect(out).toContain('invoke this CLI with sandbox bypass/escalation');
    expect(out).toContain('# Knowledge Base');
    expect(out).toContain('## Wiki');
    expect(out).toContain('## Memo');
    expect(out).not.toMatch(/<!-- (?:KB|OWNER|SESSION_ID)_ONLY:/u);
  });
});

describe('renderInject {{EQUIPPED_TOOLS}}', () => {
  it('renders the equipped-tools block under the CLI line when tools are provided', () => {
    const out = renderInject({
      pluginRoot: pluginRootWith({ tools: TEMPLATE }),
      projectDir: undefined,
      sessionId: 's',
      asOwner: true,
      kbEnabled: true,
      equippedTools: [
        {
          id: 'codebase-memory',
          summary: 'mandatory first stop for any code work.',
          guidance: ['Use search_graph before opening files.', 'Manual grep/read is a fallback only.'],
        },
      ],
    });

    expect(out).toContain('Equipped tools (installed via /equip):');
    expect(out).not.toContain('highest-priority');
    expect(out).toContain('- codebase-memory: mandatory first stop for any code work.');
    expect(out).toContain('  - Use search_graph before opening files.');
    expect(out).toContain('  - Manual grep/read is a fallback only.');
    expect(out).not.toContain('{{EQUIPPED_TOOLS}}');
  });

  it('strips the placeholder when no tools are provided (subagents / empty snapshot)', () => {
    const out = renderInject({
      pluginRoot: pluginRootWith({ tools: TEMPLATE }),
      projectDir: undefined,
      sessionId: 's',
      asOwner: false,
      kbEnabled: true,
    });

    expect(out).not.toContain('{{EQUIPPED_TOOLS}}');
    expect(out).not.toContain('Equipped tools');
    expect(out).toContain('done');
  });
});

describe('renderInject path aliases', () => {
  it('substitutes CORAL_METHODS and CORAL_PROJECT when projectDir is set', () => {
    const pluginRoot = pluginRootWith(
      'methods: {{CORAL_METHODS}}\nproject: {{CORAL_PROJECT}}\nlegacy: {{CORAL_PROJECTS}}',
    );
    const projectDir = mkdtempSync(join(tmpdir(), 'coral-inject-project-'));
    createdRoots.push(projectDir);

    const out = renderInject({
      pluginRoot,
      projectDir,
      sessionId: 's',
      asOwner: true,
      kbEnabled: true,
    });

    const lines = Object.fromEntries(
      out
        .split('\n')
        .filter(Boolean)
        .map((line: string) => {
          const i = line.indexOf(': ');
          return [line.slice(0, i), line.slice(i + 2)] as const;
        }),
    );
    expect(lines.methods).toBe(`${join(pluginRoot, 'methods')}/`);
    expect(lines.project.length).toBeGreaterThan(0);
    expect(lines.legacy).toBe(lines.project);
    expect(out).not.toContain('{{CORAL_METHODS}}');
    expect(out).not.toContain('{{CORAL_PROJECT}}');
  });

  it('leaves CORAL_PROJECT placeholder when projectDir is absent', () => {
    const out = renderInject({
      pluginRoot: pluginRootWith('project: {{CORAL_PROJECT}}\nmethods: {{CORAL_METHODS}}'),
      projectDir: undefined,
      sessionId: 's',
      asOwner: true,
      kbEnabled: true,
    });
    expect(out).toContain('project: {{CORAL_PROJECT}}');
    expect(out).toMatch(/methods: .+\/methods\/$/);
  });
});
