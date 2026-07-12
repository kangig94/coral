// Skill-name regexes used across coral hooks.
// Patterns are collected here (rather than unified) because call sites
// inspect different inputs — user message text vs. `tool_input.skill` —
// and a few variants are intentional (e.g., RALPH_FIELD_RE accepts bare
// `ralph` as well as `coral:ralph`). Keep any future normalization
// deliberate; do not silently tighten boundaries.

export const ALL_CORAL_SKILLS = [
  'plan', 'preplan', 'analyze', 'ralph', 'bid', 'discuss',
  'init-project', 'bugfix', 'code-simplify',
];

// coral-skill-vars: matches any coral skill in a user message.
export const CORAL_SKILL_MESSAGE_RE = new RegExp(
  `\\/(?:coral:)?(?:${ALL_CORAL_SKILLS.join('|')})\\b`,
);

// coral-skill-vars: matches a skill field that already carries the
// `coral:` prefix (PreToolUse on Skill tool).
export const CORAL_SKILL_FIELD_PREFIX_RE = /^coral:/;

// kb-promote-gate: user message, matches /ralph or /bugfix. Original has
// no trailing \b; preserved to avoid silent behavior change.
export const KB_SKILL_MESSAGE_RE = /\/(?:coral:)?ralph|\/(?:coral:)?bugfix/;

// kb-promote-gate: skill field, already-prefixed form only.
export const KB_SKILL_FIELD_RE = /coral:ralph|coral:bugfix/;

// ralph-loop: user message, matches only /ralph (with \b boundary).
export const RALPH_MESSAGE_RE = /\/(?:coral:)?ralph\b/;

// ralph-loop: skill field, accepts coral:ralph or bare ralph.
export const RALPH_FIELD_RE = /coral:ralph|^ralph$/;
