import { describe, expect, it } from 'vitest';
import { stripAgentMetadata } from '#src/jobs/agent-resolution.js';

describe('stripAgentMetadata', () => {
  it('removes frontmatter and CORAL_METHODS blockquote lines', () => {
    const raw = [
      '---',
      'name: architect',
      'model: sonnet',
      '---',
      '',
      '> **CORAL_METHODS**: Use strict protocol',
      '> **CORAL_NOTE**: Keep concise',
      '# Architect',
      'Main body',
    ].join('\n');

    const stripped = stripAgentMetadata(raw);

    expect(stripped).toBe('# Architect\nMain body');
  });
});
