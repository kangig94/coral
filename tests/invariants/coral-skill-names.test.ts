import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { ALL_CORAL_SKILLS, ALL_SHIPPED_SKILLS } from '../../clients/hooks/lib/coral-skills.mjs';

const SKILLS_DIR = join(process.cwd(), 'clients', 'skills');

function shippedSkillDirectories(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('coral-skills name lists', () => {
  it('ALL_SHIPPED_SKILLS mirrors clients/skills/ exactly', () => {
    // Copilot passes the bare skill name in `tool_input.skill`, so this list is
    // the only thing that recognizes a Coral skill there. A skill directory
    // added without updating it silently loses hook support under Copilot —
    // no error, just missing context injection.
    expect([...(ALL_SHIPPED_SKILLS as string[])].sort()).toEqual(shippedSkillDirectories());
  });

  it('ALL_CORAL_SKILLS stays a subset of the shipped skills', () => {
    // ALL_CORAL_SKILLS drives user-message matching and is deliberately
    // narrower; it must still name only skills that actually ship.
    expect(ALL_SHIPPED_SKILLS as string[]).toEqual(expect.arrayContaining(ALL_CORAL_SKILLS as string[]));
  });
});
