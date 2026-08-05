// Skill-name regexes used across coral hooks.
// Patterns are collected here (rather than unified) because call sites
// inspect different inputs — user message text vs. `tool_input.skill` —
// and a few variants are intentional (e.g., RALPH_FIELD_RE accepts bare
// `ralph` as well as `coral:ralph`). Keep any future normalization
// deliberate; do not silently tighten boundaries.

import { hostKind } from './hook-utils.mjs';

export const ALL_CORAL_SKILLS = [
  'plan', 'preplan', 'analyze', 'ralph', 'bid', 'discuss',
  'init-project', 'bugfix', 'code-simplify',
];

// Every skill directory shipped under clients/skills/, kept in lockstep with
// the filesystem by tests/invariants/coral-skill-names.test.ts. Used only by
// the Copilot branch of the `tool_input.skill` matchers below: Copilot passes
// the BARE skill name (`ralph`), while Claude and Codex pass the namespaced
// `coral:ralph`. Copilot falls back to the `coral:` prefix only when another
// installed plugin ships the same name, so a bare name is unambiguously ours.
// Kept separate from ALL_CORAL_SKILLS so widening the field match does not
// also widen user-message matching.
export const ALL_SHIPPED_SKILLS = [
  'analyze', 'bid', 'bugfix', 'code-simplify', 'discuss', 'equip',
  'init-project', 'pathfind', 'plan', 'preplan', 'ralph', 'statusline',
];

// coral-skill-vars: matches any coral skill in a user message.
export const CORAL_SKILL_MESSAGE_RE = new RegExp(
  `\\/(?:coral:)?(?:${ALL_CORAL_SKILLS.join('|')})\\b`,
);

// kb-promote-gate: user message, matches /ralph or /bugfix. Original has
// no trailing \b; preserved to avoid silent behavior change.
export const KB_SKILL_MESSAGE_RE = /\/(?:coral:)?ralph|\/(?:coral:)?bugfix/;

// ralph-loop: user message, matches only /ralph (with \b boundary).
export const RALPH_MESSAGE_RE = /\/(?:coral:)?ralph\b/;

// ralph-loop: skill field, accepts coral:ralph or bare ralph. Predates Copilot
// support — bare `ralph` is also how a user's own Claude skill arrives — so it
// is intentionally not host-gated.
export const RALPH_FIELD_RE = /coral:ralph|^ralph$/;

// `tool_input.skill` matchers. The bare-name branch is gated on Copilot: on
// Claude and Codex a bare `plan` or `bugfix` is a *user's own* skill of that
// name, and matching it would fire Coral's hooks (injecting context, or arming
// the KB gate into a Stop-time block) for a skill Coral does not own.
export function isCoralSkillField(skill, host = hostKind()) {
  if (/^coral:/.test(skill)) return true;
  return host === 'copilot' && ALL_SHIPPED_SKILLS.includes(skill);
}

export function isKbSkillField(skill, host = hostKind()) {
  if (/coral:ralph|coral:bugfix/.test(skill)) return true;
  return host === 'copilot' && (skill === 'ralph' || skill === 'bugfix');
}
