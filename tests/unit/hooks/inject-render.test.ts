import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function pluginRootWith(injectMd: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-inject-render-'));
  createdRoots.push(root);
  writeFileSync(join(root, 'INJECT.md'), injectMd, 'utf-8');
  return root;
}

describe('renderInject {{EQUIPPED_TOOLS}}', () => {
  it('renders the equipped-tools block under the CLI line when tools are provided', () => {
    const out = renderInject({
      pluginRoot: pluginRootWith(TEMPLATE),
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

    expect(out).toContain('mandatory first-pass capabilities');
    expect(out).toContain('Use the live MCP tools in the mcp__codebase_memory_mcp namespace');
    expect(out).toContain('- codebase-memory: mandatory first stop for any code work.');
    expect(out).toContain('  - Use search_graph before opening files.');
    expect(out).toContain('  - Manual grep/read is a fallback only.');
    expect(out).not.toContain('{{EQUIPPED_TOOLS}}');
  });

  it('strips the placeholder when no tools are provided (subagents / empty snapshot)', () => {
    const out = renderInject({
      pluginRoot: pluginRootWith(TEMPLATE),
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
