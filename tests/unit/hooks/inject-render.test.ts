import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { renderInject } from '../../../hooks/lib/inject-render.mjs';

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
