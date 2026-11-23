import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { KB_START_HOOK, expectHookOutput, runHook, writeInjectBundle } from '#tests/unit/hooks/_helpers.js';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { MAX_ADDITIONAL_CONTEXT_BYTES } from '../../../clients/hooks/lib/additional-context.mjs';
import { EQUIP_AGENT_TOOLS } from '../../../clients/hooks/lib/equip-tools.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { renderInject } from '../../../clients/hooks/lib/inject-render.mjs';

const TEMPLATE = '# Tools\n\nCLI: `{{CORAL_CLI}}`{{EQUIPPED_TOOLS}}\n\ndone';
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function pluginRootWith(input: Parameters<typeof writeInjectBundle>[1]): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-inject-render-'));
  createdRoots.push(root);
  writeInjectBundle(root, input);
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
      guidelines: ['core', 'review'],
      coral: ['tools', 'cli', 'orchestrator'],
      kb: ['kb common', 'kb orchestrator', 'kb session'],
    },
    {
      name: 'subagent session',
      asOwner: false,
      kbEnabled: true,
      guidelines: ['core'],
      coral: ['tools', 'cli'],
      kb: ['kb common', 'kb session'],
    },
    {
      name: 'KB-disabled session',
      asOwner: true,
      kbEnabled: false,
      guidelines: ['core', 'review'],
      coral: ['tools', 'cli', 'orchestrator'],
      kb: [],
    },
  ])('composes the $name fragment groups', ({ asOwner, kbEnabled, guidelines, coral, kb }) => {
    const pluginRoot = pluginRootWith({
      core: 'core',
      review: 'review',
      tools: 'tools',
      cli: 'cli',
      orchestrator: 'orchestrator',
      kbCommon: 'kb common',
      kbOrchestrator: 'kb orchestrator',
      kbSession: 'kb session',
    });
    const input = { pluginRoot, projectDir: undefined, sessionId: 's', asOwner, kbEnabled };

    expect(renderInject({ ...input, group: 'guidelines' })).toBe(guidelines.join('\n\n'));
    expect(renderInject({ ...input, group: 'coral' })).toBe(coral.join('\n\n'));
    expect(renderInject({ ...input, group: 'kb' })).toBe(kb.join('\n\n'));
  });

  it.each([
    { hook: 'session-start', group: 'guidelines', asOwner: true },
    { hook: 'subagent-start', group: 'guidelines', asOwner: false },
    { hook: 'coral-start', group: 'coral', asOwner: true },
    { hook: 'coral-start', group: 'coral', asOwner: false },
    { hook: 'kb-start', group: 'kb', asOwner: true },
    { hook: 'kb-start', group: 'kb', asOwner: false },
  ])('keeps the $hook payload in budget (asOwner=$asOwner)', ({ hook, group, asOwner }) => {
    const sessionId = 'size-gate-session';
    const content = renderInject({
      pluginRoot: join(process.cwd(), 'clients'),
      projectDir: group === 'kb' && !asOwner ? undefined : process.cwd(),
      sessionId,
      asOwner,
      group,
      equippedTools: EQUIP_AGENT_TOOLS,
    });
    const header =
      hook === 'session-start'
        ? `SessionStart:session_id=${sessionId}\nCurrent host: claude\nClaude config dir: /home/test/.claude\n\n`
        : '';

    expect(Buffer.byteLength(header + content, 'utf-8')).toBeLessThanOrEqual(MAX_ADDITIONAL_CONTEXT_BYTES);
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
      group: 'coral',
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

  it('strips the placeholder when no tools are provided (empty tool list)', () => {
    const out = renderInject({
      pluginRoot: pluginRootWith({ tools: TEMPLATE }),
      projectDir: undefined,
      sessionId: 's',
      asOwner: false,
      group: 'coral',
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
      group: 'guidelines',
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
      group: 'guidelines',
      kbEnabled: true,
    });
    expect(out).toContain('project: {{CORAL_PROJECT}}');
    expect(out).toMatch(/methods: .+\/methods\/$/);
  });
});
