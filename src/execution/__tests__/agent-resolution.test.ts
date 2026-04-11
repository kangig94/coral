import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResolutionContext } from '../agent-resolution.js';
import {
  AgentNamespaceNotFoundError,
  AgentNotFoundError,
  InvalidAgentRefError,
  formatAgentRef,
  parseAgentMeta,
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
} from '../agent-resolution.js';

const AGENT_IDENT_CASES: ReadonlyArray<
  readonly [input: string, accepted: boolean, canonicalForm: string | null]
> = [
  ['architect', true, 'architect'],
  ['coral:architect', true, 'coral:architect'],
  ['my-plugin:my-agent', true, 'my-plugin:my-agent'],
  ['ns-1:agent-2', true, 'ns-1:agent-2'],
  ['architect.md', true, 'architect'],
  ['coral:architect.md', true, 'coral:architect'],
  ['a.md', true, 'a'],
  ['coral:', false, null],
  ['MyAgent', false, null],
  ['', false, null],
  ['INVALID!', false, null],
  ['architect.md.md', false, null],
  ['.md', false, null],
] as const;

const EXTRA_INVALID_AGENT_REFS = ['../evil', 'a/b', 'a\\b', 'evil\x00name', '-starts-with-hyphen', 'a:b:c', 'agent.txt'];

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(rootDir: string, relativePath: string, content: string): string {
  const filePath = join(rootDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function createContext(options: {
  projectRoot?: string;
  coralPluginRoot?: string;
  discoverPluginRoot?: (namespace: string) => string | null;
  pluginRoots?: Readonly<Record<string, string>>;
} = {}): AgentResolutionContext {
  const discoverPluginRoot =
    options.discoverPluginRoot ?? ((namespace: string) => options.pluginRoots?.[namespace] ?? null);

  return {
    projectRoot: options.projectRoot ?? makeTmpDir('agent-resolution-project-'),
    coralPluginRoot: options.coralPluginRoot ?? makeTmpDir('agent-resolution-coral-'),
    discoverPluginRoot,
  };
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
    throw new Error('expected function to throw');
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'expected function to throw') {
      throw error;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseAgentRef', () => {
  it.each(AGENT_IDENT_CASES)(
    'parses %s with accepted=%s and canonical form %s',
    (input, accepted, canonicalForm) => {
      if (!accepted) {
        const error = captureError(() => parseAgentRef(input));
        expect(error).toBeInstanceOf(InvalidAgentRefError);
        expect((error as InvalidAgentRefError).kind).toBe('invalid_agent');
        return;
      }

      const ref = parseAgentRef(input);
      expect(formatAgentRef(ref)).toBe(canonicalForm);

      if (canonicalForm?.includes(':')) {
        const colonIndex = canonicalForm.indexOf(':');
        expect(ref).toEqual({
          namespace: canonicalForm.slice(0, colonIndex),
          name: canonicalForm.slice(colonIndex + 1),
        });
      } else {
        expect(ref).toEqual({ namespace: null, name: canonicalForm });
      }
    },
  );

  it('strips trailing .md before parsing bare and namespaced refs', () => {
    expect(parseAgentRef('architect.md')).toEqual({ namespace: null, name: 'architect' });
    expect(parseAgentRef('coral:architect.md')).toEqual({ namespace: 'coral', name: 'architect' });
  });

  it.each(EXTRA_INVALID_AGENT_REFS)('rejects invalid ref %s', (input) => {
    expect(() => parseAgentRef(input)).toThrow(InvalidAgentRefError);
  });
});

describe('resolveAgent', () => {
  it('resolves bare names by cascading project before coral', () => {
    const projectRoot = makeTmpDir('agent-resolution-project-');
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const projectPath = writeFile(projectRoot, '.claude/agents/architect.md', 'PROJECT');
    writeFile(coralPluginRoot, 'agents/architect.md', 'CORAL');
    const ctx = createContext({ projectRoot, coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('architect'), ctx);

    expect(resolved).toEqual({
      ref: { namespace: 'project', name: 'architect' },
      source: 'agent',
      content: 'PROJECT',
      path: projectPath,
    });
  });

  it('resolves bare names from coral when project does not have the agent', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const coralPath = writeFile(coralPluginRoot, 'agents/architect.md', 'CORAL');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('architect'), ctx);

    expect(resolved).toEqual({
      ref: { namespace: 'coral', name: 'architect' },
      source: 'agent',
      content: 'CORAL',
      path: coralPath,
    });
  });

  it('resolves coral skills as a fallback for bare names', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const skillPath = writeFile(coralPluginRoot, 'skills/plan/SKILL.md', '# Plan\nSkill content\n');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('plan'), ctx);

    expect(resolved).toEqual({
      ref: { namespace: 'coral', name: 'plan' },
      source: 'skill',
      content: '# Plan\nSkill content\n',
      path: skillPath,
    });
  });

  it('includes every searched project and coral path when a bare agent is missing', () => {
    const projectRoot = makeTmpDir('agent-resolution-project-');
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const ctx = createContext({ projectRoot, coralPluginRoot });

    const error = captureError(() => resolveAgent(parseAgentRef('missing'), ctx));

    expect(error).toBeInstanceOf(AgentNotFoundError);
    expect((error as AgentNotFoundError).kind).toBe('agent_not_found');
    expect(error.message).toContain(join(projectRoot, '.claude', 'agents', 'missing.md'));
    expect(error.message).toContain(join(coralPluginRoot, 'agents', 'missing.md'));
    expect(error.message).toContain(join(coralPluginRoot, 'skills', 'missing', 'SKILL.md'));
  });

  it('explicit coral namespace resolves only coral files', () => {
    const projectRoot = makeTmpDir('agent-resolution-project-');
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    writeFile(projectRoot, '.claude/agents/pioneer.md', 'PROJECT');
    const coralPath = writeFile(coralPluginRoot, 'agents/pioneer.md', 'CORAL');
    const ctx = createContext({ projectRoot, coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:pioneer'), ctx);

    expect(resolved).toEqual({
      ref: { namespace: 'coral', name: 'pioneer' },
      source: 'agent',
      content: 'CORAL',
      path: coralPath,
    });
  });

  it('explicit project namespace resolves only project files', () => {
    const projectRoot = makeTmpDir('agent-resolution-project-');
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const projectPath = writeFile(projectRoot, '.claude/agents/my-local.md', 'PROJECT');
    writeFile(coralPluginRoot, 'agents/my-local.md', 'CORAL');
    const ctx = createContext({ projectRoot, coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('project:my-local'), ctx);

    expect(resolved).toEqual({
      ref: { namespace: 'project', name: 'my-local' },
      source: 'agent',
      content: 'PROJECT',
      path: projectPath,
    });
  });

  it('does not apply skills fallback to the project namespace', () => {
    const projectRoot = makeTmpDir('agent-resolution-project-');
    writeFile(projectRoot, '.claude/skills/plan/SKILL.md', '# Plan\nProject skill content\n');
    const ctx = createContext({ projectRoot });

    const error = captureError(() => resolveAgent(parseAgentRef('project:plan'), ctx));

    expect(error).toBeInstanceOf(AgentNotFoundError);
    expect(error.message).toContain(join(projectRoot, '.claude', 'agents', 'plan.md'));
    expect(error.message).not.toContain(join(projectRoot, '.claude', 'skills', 'plan', 'SKILL.md'));
  });

  it('explicit coral namespace falls back to coral skills', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const skillPath = writeFile(coralPluginRoot, 'skills/plan/SKILL.md', '# Plan\nSkill content\n');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:plan'), ctx);

    expect(resolved).toEqual({
      ref: { namespace: 'coral', name: 'plan' },
      source: 'skill',
      content: '# Plan\nSkill content\n',
      path: skillPath,
    });
  });

  it('throws AgentNamespaceNotFoundError for an unknown plugin namespace with the restart hint', () => {
    const discoverPluginRoot = vi.fn(() => null);
    const ctx = createContext({ discoverPluginRoot });

    const error = captureError(() => resolveAgent(parseAgentRef('unknown:architect'), ctx));

    expect(discoverPluginRoot).toHaveBeenCalledWith('unknown');
    expect(error).toBeInstanceOf(AgentNamespaceNotFoundError);
    expect((error as AgentNamespaceNotFoundError).kind).toBe('agent_namespace_not_found');
    expect(error.message).toContain('Plugin namespace "unknown" not found.');
    expect(error.message).toContain('If you just installed the plugin, restart the Coral backend');
  });

  it('throws AgentNotFoundError when a known plugin namespace does not contain the agent file', () => {
    const otherPluginRoot = makeTmpDir('agent-resolution-other-');
    mkdirSync(join(otherPluginRoot, 'agents'), { recursive: true });
    const ctx = createContext({ pluginRoots: { other: otherPluginRoot } });

    const error = captureError(() => resolveAgent(parseAgentRef('other:architect'), ctx));

    expect(error).toBeInstanceOf(AgentNotFoundError);
    expect((error as AgentNotFoundError).kind).toBe('agent_not_found');
    expect(error.message).toContain(join(otherPluginRoot, 'agents', 'architect.md'));
  });

  it('does not apply skills fallback to non-coral plugin namespaces', () => {
    const otherPluginRoot = makeTmpDir('agent-resolution-other-');
    writeFile(otherPluginRoot, 'skills/foo/SKILL.md', '# Foo\nSkill content\n');
    const ctx = createContext({ pluginRoots: { other: otherPluginRoot } });

    const error = captureError(() => resolveAgent(parseAgentRef('other:foo'), ctx));

    expect(error).toBeInstanceOf(AgentNotFoundError);
    expect(error.message).toContain(join(otherPluginRoot, 'agents', 'foo.md'));
    expect(error.message).not.toContain(join(otherPluginRoot, 'skills', 'foo', 'SKILL.md'));
  });

  it('keeps coral reserved namespace resolution ahead of plugin discovery shadowing', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const shadowRoot = makeTmpDir('agent-resolution-shadow-coral-');
    writeFile(coralPluginRoot, 'agents/architect.md', 'BUILTIN');
    writeFile(shadowRoot, 'agents/architect.md', 'SHADOW');
    const discoverPluginRoot = vi.fn((namespace: string) => (namespace === 'coral' ? shadowRoot : null));
    const ctx = createContext({ coralPluginRoot, discoverPluginRoot });

    const resolved = resolveAgent({ namespace: 'coral', name: 'architect' }, ctx);

    expect(resolved.content).toBe('BUILTIN');
    expect(discoverPluginRoot).not.toHaveBeenCalledWith('coral');
  });

  it('keeps project reserved namespace resolution ahead of plugin discovery shadowing', () => {
    const projectRoot = makeTmpDir('agent-resolution-project-');
    const shadowRoot = makeTmpDir('agent-resolution-shadow-project-');
    writeFile(projectRoot, '.claude/agents/architect.md', 'BUILTIN');
    writeFile(shadowRoot, 'agents/architect.md', 'SHADOW');
    const discoverPluginRoot = vi.fn((namespace: string) => (namespace === 'project' ? shadowRoot : null));
    const ctx = createContext({ projectRoot, discoverPluginRoot });

    const resolved = resolveAgent({ namespace: 'project', name: 'architect' }, ctx);

    expect(resolved.content).toBe('BUILTIN');
    expect(discoverPluginRoot).not.toHaveBeenCalledWith('project');
  });

  it('resolves agents/<name>.md when the coral agent exists', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const agentPath = writeFile(coralPluginRoot, 'agents/architect.md', '# Architect\nAgent content\n');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:architect'), ctx);

    expect(resolved.source).toBe('agent');
    expect(resolved.path).toBe(agentPath);
    expect(resolved.content).toContain('Agent content');
  });

  it('resolves skills/<name>/SKILL.md when the coral agent does not exist', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const skillPath = writeFile(coralPluginRoot, 'skills/plan/SKILL.md', '# Plan\nSkill content\n');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:plan'), ctx);

    expect(resolved.source).toBe('skill');
    expect(resolved.path).toBe(skillPath);
    expect(resolved.content).toContain('Skill content');
  });

  it('prefers coral agents over coral skills when both exist', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    writeFile(coralPluginRoot, 'agents/scanner.md', '# Scanner\nAgent\n');
    writeFile(coralPluginRoot, 'skills/scanner/SKILL.md', '# Scanner Skill\nSkill\n');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:scanner'), ctx);

    expect(resolved.source).toBe('agent');
    expect(resolved.content).toContain('Agent');
  });

  it('throws when neither coral agent nor coral skill exists', () => {
    const ctx = createContext();
    expect(() => resolveAgent(parseAgentRef('coral:missing'), ctx)).toThrow('Agent "coral:missing" not found');
  });

  it('strips .md extension and resolves normally', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const agentPath = writeFile(coralPluginRoot, 'agents/agent.md', 'agent content');
    const ctx = createContext({ coralPluginRoot });

    const result = resolveAgent(parseAgentRef('agent.md'), ctx);

    expect(result).toEqual({
      ref: { namespace: 'coral', name: 'agent' },
      source: 'agent',
      content: 'agent content',
      path: agentPath,
    });
  });

  it('throws when a bare valid name has no matching files', () => {
    const ctx = createContext();
    expect(() => resolveAgent(parseAgentRef('z'), ctx)).toThrow('Agent "z" not found');
  });

  it('resolves a single-character valid name when the coral agent exists', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    writeFile(coralPluginRoot, 'agents/z.md', '# Z\nContent');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:z'), ctx);

    expect(resolved.source).toBe('agent');
    expect(resolved.content).toContain('Content');
  });

  it('error message for missing explicit coral content includes expected filenames', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    const ctx = createContext({ coralPluginRoot });

    const error = captureError(() => resolveAgent(parseAgentRef('coral:does-not-exist'), ctx));

    expect(error.message).toContain('agents/does-not-exist.md');
    expect(error.message).toContain('skills/does-not-exist/SKILL.md');
  });

  it('agent file with path separators in content does not affect resolution', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    writeFile(coralPluginRoot, 'agents/safe.md', '# Safe\nPath: /tmp/foo\n');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:safe'), ctx);

    expect(resolved.source).toBe('agent');
    expect(resolved.content).toContain('/tmp/foo');
  });
});

describe('parseAgentMeta', () => {
  it('extracts model from frontmatter', () => {
    expect(parseAgentMeta('---\nmodel: gpt-5.4\nname: architect\n---\n# Body')).toEqual({
      model: 'gpt-5.4',
    });
  });

  it('returns empty metadata when frontmatter is absent or lacks model', () => {
    expect(parseAgentMeta('# Body')).toEqual({});
    expect(parseAgentMeta('---\nname: architect\n---\n# Body')).toEqual({});
  });

  it('supports CRLF frontmatter parsing', () => {
    expect(parseAgentMeta('---\r\nmodel: sonnet\r\n---\r\n# Body')).toEqual({ model: 'sonnet' });
  });
});

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

  it('preserves content with no frontmatter at all', () => {
    const raw = '# My Agent\nDo the thing\n\nSecond paragraph';
    expect(stripAgentMetadata(raw)).toBe('# My Agent\nDo the thing\n\nSecond paragraph');
  });

  it('strips empty frontmatter block (--- immediately followed by ---)', () => {
    const raw = '---\n---\n# Agent\nBody text';
    expect(stripAgentMetadata(raw)).toBe('# Agent\nBody text');
  });

  it('strips CORAL_ blockquote line in the middle of content', () => {
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

  it('strips all CORAL_ variants in a single file', () => {
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

  it('does not strip regular blockquote lines', () => {
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

  it('returns empty string when file is only frontmatter and CORAL_ directives', () => {
    const raw = [
      '---',
      'name: empty-agent',
      '---',
      '> **CORAL_METHODS**: Only method',
      '> **CORAL_TOOLS**: Only tools',
    ].join('\n');
    expect(stripAgentMetadata(raw)).toBe('');
  });

  it('handles CRLF line endings in frontmatter', () => {
    const raw = '---\r\nname: agent\r\n---\r\n# Body\r\nContent';
    const stripped = stripAgentMetadata(raw);
    expect(stripped).not.toContain('---');
    expect(stripped).toContain('# Body');
  });

  it('strips indented CORAL_ blockquote lines', () => {
    const raw = '   > **CORAL_METHODS**: indented\n# Body';
    expect(stripAgentMetadata(raw)).not.toContain('CORAL_METHODS');
    expect(stripAgentMetadata(raw)).toContain('# Body');
  });
});
