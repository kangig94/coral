import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { ALL_SHIPPED_SKILLS } from '../../clients/hooks/lib/coral-skills.mjs';

const CLIENT_MANIFESTS = [
  'clients/.claude-plugin/plugin.json',
  'clients/.codex-plugin/plugin.json',
  'clients/.github/plugin/plugin.json',
] as const;

const SKILLS_DIR = join(process.cwd(), 'clients', 'skills');
const AGENTS_DIR = join(process.cwd(), 'clients', 'agents');

function skillBodies(): Array<{ skill: string; text: string }> {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ skill: entry.name, path: join(SKILLS_DIR, entry.name, 'SKILL.md') }))
    .filter(({ path }) => existsSync(path))
    .map(({ skill, path }) => ({ skill, text: readFileSync(path, 'utf-8') }));
}

/**
 * `coral:<name>` references that must resolve to an agent file.
 *
 * The `[a-z]` anchor drops the literal placeholder `coral:<agent>`, and skills are
 * subtracted because `Skill({ skill: "coral:ralph" })` names a skill, not an agent.
 * The whole file is scanned rather than only `Agent(`/`subagent_type:` sites so that
 * workflow expressions like `"(coral:architect, coral:critic) -> coral:resolver"` —
 * the reference class this invariant most needs to cover — are included.
 */
function referencedAgents(): Map<string, string[]> {
  const shipped = new Set<string>(ALL_SHIPPED_SKILLS as string[]);
  const byAgent = new Map<string, string[]>();
  for (const { skill, text } of skillBodies()) {
    for (const [, name] of text.matchAll(/coral:([a-z][a-z-]*)/gu)) {
      if (shipped.has(name)) continue;
      byAgent.set(name, [...(byAgent.get(name) ?? []), skill]);
    }
  }
  return byAgent;
}

describe('coral agent exposure', () => {
  it.each(CLIENT_MANIFESTS)('%s exposes the agent directory to its client', (manifestPath) => {
    // A client that declares an empty `agents` suppresses discovery, and every skill
    // whose default path spawns `coral:<name>` silently loses it — the spawn fails
    // inside a subagent with nothing surfacing to the session. Shipped once already
    // (`"agents": []` on the Copilot manifest), so it is asserted rather than trusted.
    // Two forms are accepted: the explicit directory, or the key absent, which is the
    // discovery default both sibling manifests rely on today.
    const manifest = JSON.parse(readFileSync(join(process.cwd(), manifestPath), 'utf-8')) as {
      agents?: unknown;
    };
    if (manifest.agents === undefined) return;
    expect(manifest.agents).toBe('./agents/');
  });

  it('every coral:<agent> a skill spawns has an agent file', () => {
    // Assertion 1 alone would pass a skill spawning an agent that does not exist —
    // the same invisible failure, reached from the other side.
    const referenced = referencedAgents();
    expect(referenced.size).toBeGreaterThan(0); // a rule matching nothing would pass vacuously

    const missing = [...referenced.entries()]
      .filter(([name]) => !existsSync(join(AGENTS_DIR, `${name}.md`)))
      .map(([name, skills]) => `${name} (referenced by ${skills.join(', ')})`);

    expect(missing).toEqual([]);
  });
});
