import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AgentResolutionContext,
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
} from '#src/jobs/agent-resolution.js';
import { createRealRuntime } from '#src/runtime/real.js';

const runtime = createRealRuntime('prod');

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

function createContext(
  options: {
    projectRoot?: string;
    coralPluginRoot?: string;
    discoverPluginRoot?: (namespace: string) => string | null;
    pluginRoots?: Readonly<Record<string, string>>;
  } = {},
): AgentResolutionContext {
  const discoverPluginRoot =
    options.discoverPluginRoot ?? ((namespace: string) => options.pluginRoots?.[namespace] ?? null);

  return {
    projectRoot: options.projectRoot ?? makeTmpDir('agent-resolution-project-'),
    coralPluginRoot: options.coralPluginRoot ?? makeTmpDir('agent-resolution-coral-'),
    discoverPluginRoot,
    storage: runtime.storage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

  it('prefers coral agents over coral skills when both exist', () => {
    const coralPluginRoot = makeTmpDir('agent-resolution-coral-');
    writeFile(coralPluginRoot, 'agents/scanner.md', '# Scanner\nAgent\n');
    writeFile(coralPluginRoot, 'skills/scanner/SKILL.md', '# Scanner Skill\nSkill\n');
    const ctx = createContext({ coralPluginRoot });

    const resolved = resolveAgent(parseAgentRef('coral:scanner'), ctx);

    expect(resolved.source).toBe('agent');
    expect(resolved.content).toContain('Agent');
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
});
