import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { KB_START_HOOK, expectHookOutput, runHook } from '#tests/unit/hooks/_helpers.js';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { MAX_ADDITIONAL_CONTEXT_BYTES } from '../../../clients/hooks/lib/additional-context.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { EQUIP_AGENT_TOOLS } from '../../../clients/hooks/lib/equip-tools.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { INJECT_FRAGMENT_GROUPS, renderInject } from '../../../clients/hooks/lib/inject-render.mjs';

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

function wakeUpFixture(understanding: string): { kbRoot: string; projectDir: string; wikiPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-inject-wake-up-'));
  createdRoots.push(root);
  const projectDir = join(root, 'project');
  const kbRoot = join(root, 'kb');
  const wikiDir = join(kbRoot, 'wiki');
  const wikiPath = join(wikiDir, `local-${basename(projectDir)}.md`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(
    wikiPath,
    [
      '---',
      'updatedAt: 2026-08-30T00:00:00.000Z',
      '---',
      '# Project',
      '',
      '## Understanding',
      '',
      understanding,
      '',
      '## Knowledge',
    ].join('\n'),
    'utf-8',
  );
  return { kbRoot, projectDir, wikiPath };
}

function emitKbStart(
  hookEventName: 'SessionStart' | 'SubagentStart',
  fixture: ReturnType<typeof wakeUpFixture>,
): string {
  const result = runHook(
    KB_START_HOOK,
    { hook_event_name: hookEventName, session_id: 'size-gate-session' },
    {
      CLAUDE_PLUGIN_ROOT: join(process.cwd(), 'clients'),
      CLAUDE_PROJECT_DIR: fixture.projectDir,
      CORAL_KB_ENABLE: '1',
      CORAL_KB_PATH: fixture.kbRoot,
      CORAL_FLAVOR: 'prod',
      HOME: fixture.projectDir,
    },
  );
  expect(result.status).toBe(0);
  return expectHookOutput(result).hookSpecificOutput.additionalContext;
}

describe('renderInject fragment composition', () => {
  it.each([
    {
      name: 'owner session',
      asOwner: true,
      kbEnabled: true,
      expectedKb: ['kb common', 'orchestrator', 'session'],
    },
    {
      name: 'subagent session',
      asOwner: false,
      kbEnabled: true,
      expectedKb: ['kb common', 'session'],
    },
    { name: 'KB-disabled session', asOwner: true, kbEnabled: false, expectedKb: [] },
  ])('composes the $name fragment groups in order', ({ asOwner, kbEnabled, expectedKb }) => {
    const pluginRoot = pluginRootWith({
      core: 'core',
      tools: 'tools',
      kbCommon: 'kb common',
      kbOrchestrator: 'orchestrator',
      kbSession: 'session',
    });
    const base = renderInject({
      pluginRoot,
      projectDir: undefined,
      sessionId: 's',
      asOwner,
      group: 'base',
      kbEnabled,
    });
    const kb = renderInject({
      pluginRoot,
      projectDir: undefined,
      sessionId: 's',
      asOwner,
      group: 'kb',
      kbEnabled,
    });

    expect(base).toBe('core\n\ntools');
    expect(kb).toBe(expectedKb.join('\n\n'));
  });

  it('renders the shipped fragment groups without legacy control markers', () => {
    const input = {
      pluginRoot: join(process.cwd(), 'clients'),
      projectDir: undefined,
      sessionId: 's',
      asOwner: true,
      kbEnabled: true,
    };
    const base = renderInject({ ...input, group: 'base' });
    const kb = renderInject({ ...input, group: 'kb' });

    expect(base).toContain('# Coral Guidelines');
    expect(base).toContain('# Tools');
    expect(base).toContain('invoke this CLI with sandbox bypass/escalation');
    expect(base).toContain("Invoking a skill that uses Coral expresses the user's intent to run Coral");
    expect(base).toContain('automatically use sandbox bypass/escalation');
    expect(kb).toContain('# Knowledge Base');
    expect(kb).toContain('## Wiki');
    expect(kb).toContain('## Memo');
    expect(`${base}\n${kb}`).not.toMatch(/<!-- (?:KB|OWNER|SESSION_ID)_ONLY:/u);
  });

  it('assigns every shipped inject fragment to exactly one payload', () => {
    const injectRoot = join(process.cwd(), 'clients', 'inject');
    const shipped: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else shipped.push(relative(injectRoot, path).split(sep).join('/'));
      }
    };
    visit(injectRoot);

    const assigned = Object.values(INJECT_FRAGMENT_GROUPS).flat() as string[];
    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual([...shipped].sort());
  });

  it.each([
    { name: 'owner without equipped tools', asOwner: true, equippedTools: undefined },
    { name: 'owner with equipped tools', asOwner: true, equippedTools: EQUIP_AGENT_TOOLS },
    { name: 'subagent without equipped tools', asOwner: false, equippedTools: undefined },
    { name: 'subagent with equipped tools', asOwner: false, equippedTools: EQUIP_AGENT_TOOLS },
  ])('keeps every rendered payload at or below 8,000 bytes for $name', ({ asOwner, equippedTools }) => {
    const input = {
      pluginRoot: join(process.cwd(), 'clients'),
      projectDir: undefined,
      sessionId: 'size-gate-session',
      asOwner,
      kbEnabled: true,
      equippedTools,
    };
    const base = renderInject({ ...input, group: 'base' });
    const kb = renderInject({ ...input, group: 'kb' });
    const basePayload = asOwner
      ? `SessionStart:session_id=size-gate-session\nCurrent host: claude\nClaude config dir: /tmp/claude\n\n${base}`
      : base;

    expect(Buffer.byteLength(basePayload, 'utf-8')).toBeLessThanOrEqual(MAX_ADDITIONAL_CONTEXT_BYTES);
    expect(Buffer.byteLength(kb, 'utf-8')).toBeLessThanOrEqual(MAX_ADDITIONAL_CONTEXT_BYTES);
  });

  it('fits the real KB hooks when the project wiki wake-up exceeds the payload budget', () => {
    const normalFixture = wakeUpFixture('Normal project understanding.');
    const oversizedFixture = wakeUpFixture(`${'🪸'.repeat(10_000)}\nOVERSIZED-END`);

    const normalOwner = emitKbStart('SessionStart', normalFixture);
    const oversizedOwner = emitKbStart('SessionStart', oversizedFixture);
    const normalSubagent = emitKbStart('SubagentStart', normalFixture);
    const oversizedSubagent = emitKbStart('SubagentStart', oversizedFixture);

    expect(Buffer.byteLength(normalOwner, 'utf-8')).toBeLessThan(MAX_ADDITIONAL_CONTEXT_BYTES);
    expect(Buffer.byteLength(oversizedOwner, 'utf-8')).toBeLessThanOrEqual(MAX_ADDITIONAL_CONTEXT_BYTES);
    expect(oversizedOwner).toContain('project wiki wake-up was trimmed to fit this hook payload');
    expect(oversizedOwner).toContain(oversizedFixture.wikiPath);
    expect(oversizedOwner).not.toContain('OVERSIZED-END');
    expect(oversizedOwner).not.toContain('\uFFFD');
    expect(Buffer.byteLength(normalSubagent, 'utf-8')).toBeLessThan(MAX_ADDITIONAL_CONTEXT_BYTES);
    expect(oversizedSubagent).toBe(normalSubagent);
  });
});

describe('renderInject {{EQUIPPED_TOOLS}}', () => {
  it('renders the equipped-tools block under the CLI line when tools are provided', () => {
    const out = renderInject({
      pluginRoot: pluginRootWith({ tools: TEMPLATE }),
      projectDir: undefined,
      sessionId: 's',
      asOwner: true,
      group: 'base',
      kbEnabled: true,
      equippedTools: [
        {
          id: 'codebase-memory',
          summary: 'mandatory first stop for any code work.',
          guidance: ['Use search_graph before opening files.', 'Manual grep/read is a fallback only.'],
        },
      ],
    });

    expect(out).toContain('⚠ Equipped tools are capabilities the user explicitly installed via /equip');
    expect(out).toContain('MUST use every applicable equipped tool as the highest-priority first pass');
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
      group: 'base',
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
      group: 'base',
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
      group: 'base',
      kbEnabled: true,
    });
    expect(out).toContain('project: {{CORAL_PROJECT}}');
    expect(out).toMatch(/methods: .+\/methods\/$/);
  });
});
