/**
 * Invariant: every CORAL_* environment variable the KB daemon reads from its own
 * process.env carries the `CORAL_KB_` prefix, except for an explicit allowlist of
 * parent-owned shared knobs.
 *
 * Why this is load-bearing: the KB daemon is spawned through `composeChildEnv`
 * (`src/infra/env-sanitize.ts`), which strips ALL inherited `CORAL_*` from the child
 * env. The supervisor re-injects them with a single prefix rule —
 * `collectForwardedKbDaemonEnv` forwards every inherited `CORAL_KB_*` plus the
 * `PARENT_FORWARDED_KB_ENV` allowlist (`src/coordinator/live/kb-daemon-supervisor.ts`).
 * A new daemon-read CORAL var that does NOT carry the prefix (and is not allowlisted)
 * would be silently dropped before reaching the daemon — exactly the class of bug
 * this convention exists to prevent. This test fails the moment such a var is added,
 * so the forwarding rule and the naming convention can never drift apart.
 *
 * Scan scope: the token regex matches CORAL_* anywhere in the source — including
 * comments and string literals, not only `env.get(...)` call sites. That breadth is
 * intentional: a stray non-CORAL_KB_ mention in prose is itself drift worth catching.
 * Dynamically composed key names (e.g. `'CORAL_KB_' + suffix`) are out of reach; daemon
 * env reads use literal names by convention, so this limit is acceptable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CORAL_KB_ENV_PREFIX, PARENT_FORWARDED_KB_ENV } from '#src/coordinator/live/kb-daemon-supervisor.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_ROOTS = ['src/kb', 'src/kb-daemon'];
const ALLOWLISTED = new Set<string>(PARENT_FORWARDED_KB_ENV);

function collectTsFiles(absoluteDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const full = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('KB daemon CORAL_* env prefix convention', () => {
  it('every CORAL_* var referenced under src/kb and src/kb-daemon is CORAL_KB_ prefixed or allowlisted', () => {
    const offenders = new Map<string, string>();

    for (const root of SCANNED_ROOTS) {
      for (const file of collectTsFiles(join(REPO_ROOT, root))) {
        const source = readFileSync(file, 'utf-8');
        for (const match of source.matchAll(/CORAL_[A-Z0-9_]+/g)) {
          const token = match[0];
          if (token.startsWith(CORAL_KB_ENV_PREFIX) || ALLOWLISTED.has(token)) {
            continue;
          }
          if (!offenders.has(token)) {
            offenders.set(token, file.slice(REPO_ROOT.length + 1));
          }
        }
      }
    }

    expect(
      [...offenders.entries()].map(([token, file]) => `${token} (${file})`),
      'non-CORAL_KB_ env vars used by the KB daemon must be renamed to the CORAL_KB_ prefix ' +
        'so collectForwardedKbDaemonEnv forwards them, or added to PARENT_FORWARDED_KB_ENV if owned by the parent',
    ).toEqual([]);
  });
});
