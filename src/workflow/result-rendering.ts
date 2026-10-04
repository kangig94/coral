import type { StepDetail } from './execution-contract.js';

export function serializeWorkflowResult(details: StepDetail[]): {
  markdown: string;
} {
  const lines: string[] = [];

  for (const detail of details) {
    lines.push(`# Step ${detail.stepIndex}.${detail.atomIndex}: ${detail.label}`);
    lines.push('');
    const contentLines = detail.output.split('\n');
    lines.push(...contentLines);
    lines.push('');
  }

  return {
    markdown: lines.join('\n'),
  };
}
