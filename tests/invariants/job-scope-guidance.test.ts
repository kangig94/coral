import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type GuidanceBlock = {
  readonly file: string;
  readonly launch: string;
  readonly end: string;
  readonly waits: readonly string[];
};

const GUIDANCE_BLOCKS: readonly GuidanceBlock[] = [
  {
    file: 'docs/skills.md',
    launch: 'coral-cli codex -i "<prompt>" --work-dir "<path>" -d',
    end: '\n```\n\nRules:',
    waits: ['cd "<path>" && coral-cli wait jobs <jobId> --embed'],
  },
  {
    file: 'docs/agents.md',
    launch: 'coral-cli codex architect -i "<prompt>" --work-dir "<path>" -d',
    end: '\n```\n\nBehavior:',
    waits: ['cd "<path>" && coral-cli wait jobs <job-id...> --embed'],
  },
  {
    file: 'docs/agents.md',
    launch: 'coral-cli codex <name> -i "<prompt>" --work-dir "<path>" -d',
    end: '\n```\n\n### Prompt design guidance',
    waits: ['cd "<path>" && coral-cli wait jobs <job> --embed'],
  },
  {
    file: 'clients/skills/analyze/SKILL.md',
    launch: 'coral-cli <other-host> <role_name> -i "<--deep prompt>" --work-dir "<work_dir>" -d',
    end: '\nOn error, abort',
    waits: [
      'cd "<work_dir>" && coral-cli wait jobs <job> --embed',
      'cd "<work_dir>" && coral-cli wait jobs <job> --cursor <cursor> --embed',
    ],
  },
  {
    file: 'clients/skills/bugfix/SKILL.md',
    launch: 'coral-cli <other-host> debugger -i "<--deep prompt>" --work-dir "<work_dir>" -d',
    end: '\n     On error',
    waits: [
      'cd "<work_dir>" && coral-cli wait jobs <job> --embed',
      'cd "<work_dir>" && coral-cli wait jobs <job> --cursor <cursor> --embed',
    ],
  },
  {
    file: 'clients/skills/code-simplify/SKILL.md',
    launch:
      'coral-cli <other-host> -b -i "<Execution + Constraints + Failure_Modes_To_Avoid + Output_Format + target file paths + coding standards>" --work-dir "<project root>" -d',
    end: '\n    5) Review',
    waits: [
      'cd "<project root>" && coral-cli wait jobs <job> --embed',
      'cd "<project root>" && coral-cli wait jobs <job> --cursor <cursor> --embed',
      'cd "<project root>" && coral-cli wait jobs <job-id...> --embed',
    ],
  },
  {
    file: 'clients/skills/plan/SKILL.md',
    launch:
      'coral-cli workflow -e "${expression}" -s "${startPrompt}" -c "${sharedContext}" -p "{phase provider}" -w "{work_dir}" -d',
    end: '\n\n    A phase',
    waits: [
      'cd "{work_dir}" && coral-cli wait jobs <job>',
      'cd "{work_dir}" && coral-cli wait jobs <job> --cursor <cursor>',
    ],
  },
  {
    file: 'clients/skills/preplan/SKILL.md',
    launch: 'coral-cli <other-host> pioneer -i "<draft file content>" --work-dir "<work_dir>" -d',
    end: '\n    ```',
    waits: [
      'cd "<work_dir>" && coral-cli wait jobs ${job} --embed',
      'cd "<work_dir>" && coral-cli wait jobs ${job} --cursor <cursor> --embed',
    ],
  },
  {
    file: 'clients/skills/ralph/SKILL.md',
    launch: 'coral-cli <other-host> -b -i "<ACs + file paths + constraints>" --work-dir "<project root>" -d',
    end: '\n    3. Verify',
    waits: [
      'cd "<project root>" && coral-cli wait jobs <job-id...> --embed',
      'cd "<project root>" && coral-cli wait jobs <job-id...> --cursor <cursor> --embed',
    ],
  },
  {
    file: 'clients/skills/ralph/SKILL.md',
    launch:
      'coral-cli <other-host> -b -i "<above structure + file paths + constraints>" --work-dir "<project root>" -d',
    end: '\n       2. Verify',
    waits: [
      'cd "<project root>" && coral-cli wait jobs <job> --embed',
      'cd "<project root>" && coral-cli wait jobs <job> --cursor <cursor> --embed',
    ],
  },
  {
    file: '.claude/agents/ux-critic.md',
    launch: 'Level 3: `coral-cli codex -i "..." --work-dir "<path>" -d`',
    end: '\n       b.',
    waits: ['cd "<path>" && coral-cli wait jobs "<job>" --embed'],
  },
  {
    file: '.claude/rules/plugin-extension.md',
    launch: 'coral-cli codex <agent> -i "<prompt>" --work-dir "<path>" -d',
    end: '\n```',
    waits: ['cd "<path>" && coral-cli wait jobs "<job>" --embed'],
  },
];

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function waitCommands(source: string): string[] {
  const commands: string[] = [];
  for (const line of source.split('\n')) {
    if (!line.includes('coral-cli wait jobs')) continue;
    const inlineSpans = [...line.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? '');
    const inlineCommands = inlineSpans.filter(
      (span) => span.startsWith('cd ') || span.startsWith('coral-cli wait jobs'),
    );
    if (inlineCommands.length > 0) {
      commands.push(...inlineCommands);
      continue;
    }
    if (inlineSpans.length > 0) continue;
    const starts = [line.indexOf('cd "'), line.indexOf('coral-cli wait jobs')].filter((index) => index >= 0);
    const start = Math.min(...starts);
    if (Number.isFinite(start)) commands.push(line.slice(start).trim());
  }
  return commands;
}

function validateGuidanceBlock(source: string, block: GuidanceBlock): string[] {
  const violations: string[] = [];
  const launchCount = occurrences(source, block.launch);
  if (launchCount !== 1) violations.push(`expected one launch anchor, found ${launchCount}`);
  const launchIndex = source.indexOf(block.launch);
  const endIndex = launchIndex < 0 ? -1 : source.indexOf(block.end, launchIndex + block.launch.length);
  if (endIndex < 0) violations.push('expected the launch block boundary');
  if (launchIndex < 0 || endIndex < 0) return violations;

  const launchBlock = source.slice(launchIndex, endIndex);
  const expectedWaits = [...block.waits].sort();
  const actualWaits = waitCommands(launchBlock).sort();
  if (JSON.stringify(actualWaits) !== JSON.stringify(expectedWaits)) {
    violations.push(`expected wait commands ${JSON.stringify(expectedWaits)}, found ${JSON.stringify(actualWaits)}`);
  }
  return violations;
}

describe('job-scope launch guidance', () => {
  it('keeps every wait invocation complete and inside its work-dir launch block', () => {
    for (const block of GUIDANCE_BLOCKS) {
      const source = readFileSync(resolve(ROOT, block.file), 'utf8');
      expect(validateGuidanceBlock(source, block), block.file).toEqual([]);
    }
  });

  it('rejects a bare wait even when a complete invocation appears after the block', () => {
    const block = GUIDANCE_BLOCKS[0];
    if (block === undefined) throw new Error('Expected at least one guidance block.');
    const source = readFileSync(resolve(ROOT, block.file), 'utf8');
    const completeWait = block.waits[0];
    if (completeWait === undefined) throw new Error('Expected at least one wait command.');
    const mutated = `${source.replace(completeWait, 'cd "<path>" && coral-cli wait jobs')}\n${completeWait}\n`;

    expect(validateGuidanceBlock(mutated, block)).toHaveLength(1);
  });

  it('rejects an extra bare wait inside an otherwise valid launch block', () => {
    const block = GUIDANCE_BLOCKS[0];
    if (block === undefined) throw new Error('Expected at least one guidance block.');
    const source = readFileSync(resolve(ROOT, block.file), 'utf8');
    const mutated = source.replace(block.launch, `${block.launch}\ncoral-cli wait jobs <other-job> --embed`);

    expect(validateGuidanceBlock(mutated, block)).toHaveLength(1);
  });
});
