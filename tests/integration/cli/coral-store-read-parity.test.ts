import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readKnowledgeBaseEntry } from '#src/kb/queries.js';
import { createKbQueryHost } from '#src/read-model/kb-query-runtime.js';

function writeKbNote(kbRoot: string): void {
  const notesDir = join(kbRoot, 'notes');
  mkdirSync(notesDir, { recursive: true });

  writeFileSync(
    join(notesDir, 'coral-kb-mode.md'),
    `---
tags: [coral, kb]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 11
---
# KB Mode

## Rule
Keep the JSON index authoritative.
`,
    'utf8',
  );
}

describe('cli coral-store direct read', () => {
  let tempHome: string;
  let projectRoot: string;
  let originalHome: string | undefined;
  let originalKbPath: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalKbPath = process.env.CORAL_KB_PATH;
    tempHome = mkdtempSync(join(tmpdir(), 'coral-store-direct-read-'));
    projectRoot = join(tempHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalKbPath === undefined) {
      delete process.env.CORAL_KB_PATH;
    } else {
      process.env.CORAL_KB_PATH = originalKbPath;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('resolves direct-read kb read root from plugin flavor when CORAL_KB_PATH is unset', () => {
    const devPluginRoot = join(tempHome, 'dev-plugin');
    const devKbRoot = join(tempHome, '.coral', 'kb-dev');
    const prodKbRoot = join(tempHome, '.coral', 'kb');

    mkdirSync(join(devPluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(devPluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'dev-test', flavor: 'dev' }),
      'utf8',
    );

    writeKbNote(devKbRoot);
    mkdirSync(join(prodKbRoot, 'notes'), { recursive: true });
    writeFileSync(
      join(prodKbRoot, 'notes', 'coral-kb-mode.md'),
      `---
tags: [prod]
principles: []
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 99
---
# Production Root

This note must not be read from a dev plugin.
`,
      'utf8',
    );

    delete process.env.CORAL_KB_PATH;

    const result = readKnowledgeBaseEntry(
      { note: 'coral-kb-mode' },
      createKbQueryHost({ projectRoot, pluginRoot: devPluginRoot }),
    );

    expect(result.title).toBe('KB Mode');
    expect(result.content).toContain('Keep the JSON index authoritative.');
  });
});
