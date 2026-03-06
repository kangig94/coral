import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Integration tests run the actual backend binary in a subprocess.
// They require bridge/coral-backend.cjs to exist (run npm run build first).
// Tests use isolated HOME dirs to avoid ~/.claude/coral/ conflicts.

const BACKEND_BIN = fileURLToPath(new URL('../../../../bridge/coral-backend.cjs', import.meta.url));

describe('backend lifecycle (integration)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it.skip('concurrent cold start: single owner, others back off', async () => {
    expect(BACKEND_BIN).toContain('coral-backend.cjs');
    // TODO: spawn 2+ backends with HOME=tmpHome, verify single /health success
  });

  it.skip('SIGKILL recovery: stale lock/info cleaned up on next startup', async () => {
    expect(BACKEND_BIN).toContain('coral-backend.cjs');
    // TODO: spawn backend, SIGKILL, spawn again, verify clean recovery
  });

  it.skip('version mismatch: lock holder replaces, followers reuse new backend', async () => {
    expect(BACKEND_BIN).toContain('coral-backend.cjs');
    // TODO: start old-version backend, proxy detects mismatch, new backend starts
  });
});
