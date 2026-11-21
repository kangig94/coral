import { readdirSync, readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

const templates = 'clients/skills/init-project/templates';
const sharedCritics = ['code-critic', 'doc-critic', 'test-critic', 'ux-critic'];
const reviewerDirectories = [
  { directory: `${templates}/agents`, reviewers: sharedCritics },
  {
    directory: '.claude/agents',
    reviewers: [...sharedCritics, 'hook-safety', 'integration-guardian', 'skill-quality'],
  },
];
const ruleReports = [
  ...reviewerDirectories.flatMap(({ directory, reviewers }) => reviewers.map((name) => `${directory}/${name}.md`)),
  'clients/agents/critic.md',
  `${templates}/skills/tier-review/SKILL.md`,
  '.claude/skills/tier-review/SKILL.md',
];
const reports = [...ruleReports, `${templates}/agents/AGENT.md.template`];
const detailColumns = ['File:Line', 'Location', 'Skill', 'Agent(s)'];

function findingTierRules(prompt: string): string[][] {
  return Array.from(prompt.matchAll(/<Finding_Tier_Rules>([\s\S]*?)<\/Finding_Tier_Rules>/gu), ([, body]) =>
    body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

it.each(reviewerDirectories)('$directory inventories every reviewer agent', ({ directory, reviewers }) => {
  const files = readdirSync(directory).filter((name) => name.endsWith('.md'));
  expect(files.sort()).toEqual(reviewers.map((name) => `${name}.md`).sort());
});

const canonicalRules = findingTierRules(readFileSync(`${templates}/agents/code-critic.md`, 'utf8'));

it.each(ruleReports)('%s uses the shared finding-tier rules', (path) => {
  const rules = findingTierRules(readFileSync(path, 'utf8'));
  expect(rules).toHaveLength(1);
  expect(rules[0]).not.toEqual([]);
  expect(rules).toEqual(canonicalRules);
});

it.each(reports)('%s uses the shared findings tiers and columns', (path) => {
  const prompt = readFileSync(path, 'utf8');
  const [, findings = ''] = prompt.split(/^ *### (?:Consolidated )?Findings *$/mu);
  const [block = ''] = findings.split(/^ *### |^ *<\/Output_Format>|^```/mu);
  const tables = Array.from(block.matchAll(/^ *#### (.+)\r?\n\s*\|(.+)\| *$/gmu), ([, section, header]) => ({
    section: section.trim(),
    columns: header.split('|').map((column) => column.trim()),
  }));

  const columns = tables[0]?.columns ?? [];
  expect(columns.filter((column) => !detailColumns.includes(column))).toEqual([
    '#',
    'Severity',
    'Finding',
    'Suggestion',
  ]);
  expect(tables).toEqual([
    { section: 'In scope', columns },
    { section: 'Out of scope', columns: [...columns, 'Why out of scope'] },
    {
      section: 'Improbable',
      columns: [...columns, 'Required condition — why unrealistic — attacker-creatable yes/no'],
    },
  ]);
});
