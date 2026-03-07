import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let tmpDir = '';

async function loadResolver(pluginRoot?: string) {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (pluginRoot !== undefined) {
    vi.stubGlobal('__PLUGIN_ROOT__', pluginRoot);
  }
  return import('../resolver.js');
}

describe('runner coral-resolver', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-resolver-test-'));
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves agents/<name>.md when agent exists', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), '# Architect\nAgent content\n');

    const resolved = resolveCoralContent('architect');

    expect(resolved.type).toBe('agent');
    expect(resolved.path).toBe(join(tmpDir, 'agents', 'architect.md'));
    expect(resolved.content).toContain('Agent content');
  });

  it('resolves skills/<name>/SKILL.md when agent does not exist', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    mkdirSync(join(tmpDir, 'skills', 'plan'), { recursive: true });
    writeFileSync(join(tmpDir, 'skills', 'plan', 'SKILL.md'), '# Plan\nSkill content\n');

    const resolved = resolveCoralContent('plan');

    expect(resolved.type).toBe('skill');
    expect(resolved.path).toBe(join(tmpDir, 'skills', 'plan', 'SKILL.md'));
    expect(resolved.content).toContain('Skill content');
  });

  it('prefers agents over skills when both exist', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    writeFileSync(join(tmpDir, 'agents', 'scanner.md'), '# Scanner\nAgent\n');
    mkdirSync(join(tmpDir, 'skills', 'scanner'), { recursive: true });
    writeFileSync(join(tmpDir, 'skills', 'scanner', 'SKILL.md'), '# Scanner Skill\nSkill\n');

    const resolved = resolveCoralContent('scanner');

    expect(resolved.type).toBe('agent');
    expect(resolved.content).toContain('Agent');
  });

  it('throws when neither agent nor skill exists', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('missing')).toThrow('Coral content not found');
  });

  it('rejects path traversal and path separator names', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('../evil')).toThrow('Invalid coral target name');
    expect(() => resolveCoralContent('a/b')).toThrow('Invalid coral target name');
    expect(() => resolveCoralContent('a\\b')).toThrow('Invalid coral target name');
  });

  it('stripAgentMetadata removes frontmatter and CORAL_METHODS blockquote lines', async () => {
    const { stripAgentMetadata } = await loadResolver(tmpDir);
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

describe('coral-resolver stripAgentMetadata edge cases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('preserves content with no frontmatter at all', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = '# My Agent\nDo the thing\n\nSecond paragraph';
    expect(stripAgentMetadata(raw)).toBe('# My Agent\nDo the thing\n\nSecond paragraph');
  });

  it('strips empty frontmatter block (--- immediately followed by ---)', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = '---\n---\n# Agent\nBody text';
    expect(stripAgentMetadata(raw)).toBe('# Agent\nBody text');
  });

  it('strips CORAL_ blockquote line in the middle of content', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = [
      '# Section one',
      'Intro text',
      '',
      '> **CORAL_METHODS**: Do this',
      '',
      '## Section two',
      'More text',
    ].join('\n');
    const stripped = stripAgentMetadata(raw);
    expect(stripped).not.toContain('CORAL_METHODS');
    expect(stripped).toContain('# Section one');
    expect(stripped).toContain('## Section two');
  });

  it('strips all CORAL_ variants in a single file', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = [
      '---',
      'title: Multi-coral',
      '---',
      '> **CORAL_METHODS**: Method list',
      '> **CORAL_TOOLS**: Tool list',
      '> **CORAL_NOTE**: A note',
      '> **CORAL_ANYTHING_123**: Catch-all',
      '# Body',
    ].join('\n');
    const stripped = stripAgentMetadata(raw);
    expect(stripped).not.toContain('CORAL_');
    expect(stripped).toBe('# Body');
  });

  it('does not strip regular blockquote lines', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = [
      '> This is a regular blockquote',
      '> **CORAL_METHODS**: Should be stripped',
      '> Another regular quote',
      '# Body',
    ].join('\n');
    const stripped = stripAgentMetadata(raw);
    expect(stripped).toContain('> This is a regular blockquote');
    expect(stripped).toContain('> Another regular quote');
    expect(stripped).not.toContain('CORAL_METHODS');
  });

  it('returns empty string when file is only frontmatter and CORAL_ directives', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = [
      '---',
      'name: empty-agent',
      '---',
      '> **CORAL_METHODS**: Only method',
      '> **CORAL_TOOLS**: Only tools',
    ].join('\n');
    expect(stripAgentMetadata(raw)).toBe('');
  });

  it('handles CRLF line endings in frontmatter', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = '---\r\nname: agent\r\n---\r\n# Body\r\nContent';
    const stripped = stripAgentMetadata(raw);
    expect(stripped).not.toContain('---');
    expect(stripped).toContain('# Body');
  });

  it('strips indented CORAL_ blockquote lines', async () => {
    const { stripAgentMetadata } = await loadResolver();
    const raw = '   > **CORAL_METHODS**: indented\n# Body';
    expect(stripAgentMetadata(raw)).not.toContain('CORAL_METHODS');
    expect(stripAgentMetadata(raw)).toContain('# Body');
  });
});

describe('coral-resolver resolveCoralContent name validation', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-resolver-validation-'));
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects name with null byte', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('evil\x00name')).toThrow('Invalid coral target name');
  });

  it('rejects empty string', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('')).toThrow('Invalid coral target name');
  });

  it('rejects name starting with a hyphen', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('-starts-with-hyphen')).toThrow('Invalid coral target name');
  });

  it('rejects name with uppercase letters', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('MyAgent')).toThrow('Invalid coral target name');
  });

  it('rejects name with dot (path extension attempt)', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('agent.md')).toThrow('Invalid coral target name');
  });

  it('rejects name with forward slash', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('a/b')).toThrow('Invalid coral target name');
  });

  it('throws "Coral content not found" for valid name with no matching files', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    expect(() => resolveCoralContent('z')).toThrow('Coral content not found');
  });

  it('resolves single-character valid name when agent file exists', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    writeFileSync(join(tmpDir, 'agents', 'z.md'), '# Z\nContent');
    const resolved = resolveCoralContent('z');
    expect(resolved.type).toBe('agent');
    expect(resolved.content).toContain('Content');
  });

  it('error message for missing content includes expected filenames', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    try {
      resolveCoralContent('does-not-exist');
      expect.fail('should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('agents/does-not-exist.md');
      expect(msg).toContain('skills/does-not-exist/SKILL.md');
    }
  });

  it('agent file with path separators in content does not affect resolution', async () => {
    const { resolveCoralContent } = await loadResolver(tmpDir);
    writeFileSync(join(tmpDir, 'agents', 'safe.md'), '# Safe\nPath: /tmp/foo\n');
    const resolved = resolveCoralContent('safe');
    expect(resolved.type).toBe('agent');
    expect(resolved.content).toContain('/tmp/foo');
  });
});
