import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(REPO_ROOT, 'tests/invariants/fixtures/no-upgrade-eviction.ts.txt');

type Source = Readonly<{ file: string; text: string }>;
type Rule = Readonly<{
  id: string;
  appliesTo(file: string): boolean;
  pattern: RegExp;
}>;

const RULES: readonly Rule[] = [
  {
    id: 'ipc-replacement-drain',
    appliesTo: (file) => file === 'src/transport/ipc/server.ts',
    pattern: /\brequestDrain\s*\(\s*['"]replaced['"]\s*\)/u,
  },
  {
    id: 'contender-signal-escalation',
    appliesTo: (file) => file === 'src/coordinator/handoff.ts' || file === 'src/transport/ipc/handoff.ts',
    pattern: /\b(?:SIGTERM|SIGKILL|requestIncumbentShutdown|signalIncumbent|signalTarget)\b|\b(?:process|runtime\.process)\.kill\s*\(/u,
  },
  {
    id: 'handoff-signal-ledger',
    appliesTo: () => true,
    pattern: /handoff-signal\.json/u,
  },
  {
    id: 'handoff-signal-policy',
    appliesTo: () => true,
    pattern: /\b(?:CORAL_HANDOFF_SIGNAL_POLICY|HANDOFF_SIGNAL_POLICY_ENV)\b/u,
  },
  {
    id: 'handoff-signal-codes',
    appliesTo: () => true,
    pattern: /\bhandoff_(?:fresh_discovery_|signal_|legacy_signal_|manual_policy\b|term_only_policy\b|process_identity_|process_liveness_|platform_identity_|published_incarnation_|pid_recycled\b|accepted_signal_|sigkill_grace_)/u,
  },
  {
    id: 'pre-routing-eviction',
    appliesTo: (file) => file === 'src/coordinator/lifecycle.ts',
    pattern: /\brequestIncumbentShutdown\b|\brequestDrain\s*\(\s*['"]replaced['"]\s*\)/u,
  },
  {
    id: 'store-live-work-enumeration',
    appliesTo: (file) => file.startsWith('src/store/'),
    pattern: /\b(?:inspectStoreDirectoryLiveWork|inspectEpochLiveWork|isEpochLockReadable|EpochLiveWork|beforeRemoval)\b|['"](?:retained-work|live-work|unobservable-work)['"]/u,
  },
  {
    id: 'inspection-computed-store-role',
    appliesTo: (file) => file.startsWith('src/store/'),
    pattern: /\brole\s*:[^;\n]*['"]retained['"]/u,
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function source(file: string, contents: string): Source {
  return { file, text: contents };
}

function violations(sources: readonly Source[]): string[] {
  return sources.flatMap(({ file, text }) =>
    RULES.filter((rule) => rule.appliesTo(file) && rule.pattern.test(text)).map((rule) => `${rule.id}: ${file}`),
  );
}

function fixtureMutations(): Map<string, Source> {
  const text = readFileSync(FIXTURE, 'utf8');
  const mutations = new Map<string, Source>();
  const blocks = text.matchAll(/^\/\/ @mutation ([\w-]+) (src\/[^\n]+)\n([\s\S]*?)^\/\/ @end$/gmu);
  for (const [, id, file, contents] of blocks) {
    if (id === undefined || file === undefined || contents === undefined || mutations.has(id)) {
      throw new Error('Invalid upgrade eviction fixture');
    }
    mutations.set(id, source(file, contents));
  }
  return mutations;
}

const PRODUCTION = sourceFiles(join(REPO_ROOT, 'src')).map((path) =>
  source(relative(REPO_ROOT, path).replace(/\\/gu, '/'), readFileSync(path, 'utf8')),
);
const MUTATIONS = fixtureMutations();

describe('upgrade succession has no retired eviction path', () => {
  it('finds no retired behavior in production source', () => {
    expect(PRODUCTION.length).toBeGreaterThan(0);
    expect(violations(PRODUCTION)).toEqual([]);
  });

  it('has one isolated negative fixture per rule', () => {
    expect([...MUTATIONS.keys()].sort()).toEqual(RULES.map(({ id }) => id).sort());
  });

  it.each(RULES)('rejects the $id fixture', (rule) => {
    const mutation = MUTATIONS.get(rule.id);
    expect(mutation).toBeDefined();
    if (mutation === undefined) return;
    expect(violations([mutation])).toEqual([`${rule.id}: ${mutation.file}`]);
  });
});
