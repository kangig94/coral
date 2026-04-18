import { join, resolve, sep } from 'node:path';
import { AGENT_IDENT_RE } from '../../shared/utils.js';
import type { RuntimeStoragePort } from '../../runtime/ports.js';

export type AgentRef = { readonly namespace: string | null; readonly name: string };

export type ResolvedAgent = {
  readonly ref: AgentRef;
  readonly source: 'agent' | 'skill';
  readonly content: string;
  readonly path: string;
};

export type AgentResolutionContext = {
  readonly projectRoot: string;
  readonly coralPluginRoot: string;
  readonly discoverPluginRoot: (namespace: string) => string | null;
  readonly storage: Pick<RuntimeStoragePort, 'existsSync' | 'readFileSync'>;
};

type NamespaceSource = {
  readonly agentsDir: string;
  readonly skillsDir?: string;
};

type ResolutionAttempt = {
  readonly result: ResolvedAgent | null;
  readonly searchedPaths: readonly string[];
};

export class InvalidAgentRefError extends Error {
  readonly kind = 'invalid_agent' as const;

  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidAgentRefError';
  }
}

export class AgentNotFoundError extends Error {
  readonly kind = 'agent_not_found' as const;

  constructor(msg: string) {
    super(msg);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentNamespaceNotFoundError extends Error {
  readonly kind = 'agent_namespace_not_found' as const;

  constructor(msg: string) {
    super(msg);
    this.name = 'AgentNamespaceNotFoundError';
  }
}

export function parseAgentRef(input: string): AgentRef {
  const normalized = stripTrailingMd(input);
  if (!AGENT_IDENT_RE.test(normalized)) {
    throw new InvalidAgentRefError(
      'Agent must be "<name>" or "<namespace>:<name>" (lowercase letters, digits, hyphens)',
    );
  }

  const colonIndex = normalized.indexOf(':');
  if (colonIndex === -1) {
    return { namespace: null, name: normalized };
  }

  return {
    namespace: normalized.slice(0, colonIndex),
    name: normalized.slice(colonIndex + 1),
  };
}

export function formatAgentRef(ref: AgentRef): string {
  return ref.namespace === null ? ref.name : `${ref.namespace}:${ref.name}`;
}

export function resolveAgent(ref: AgentRef, ctx: AgentResolutionContext): ResolvedAgent {
  if (ref.namespace === null) {
    const projectAttempt = tryResolveExplicit({ namespace: 'project', name: ref.name }, ctx);
    if (projectAttempt.result !== null) return projectAttempt.result;

    const coralAttempt = tryResolveExplicit({ namespace: 'coral', name: ref.name }, ctx);
    if (coralAttempt.result !== null) return coralAttempt.result;

    throw new AgentNotFoundError(
      `Agent "${ref.name}" not found. Searched: ${[...projectAttempt.searchedPaths, ...coralAttempt.searchedPaths].join(', ')}`,
    );
  }

  const attempt = tryResolveExplicit({ namespace: ref.namespace, name: ref.name }, ctx);
  if (attempt.result === null) {
    throw new AgentNotFoundError(
      `Agent "${formatAgentRef(ref)}" not found. Searched: ${attempt.searchedPaths.join(', ')}`,
    );
  }

  return attempt.result;
}

export function parseAgentMeta(content: string): { model?: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};

  const fm = fmMatch[1];
  const modelMatch = fm.match(/^model:\s*(.+)$/m);
  if (!modelMatch) return {};

  return { model: modelMatch[1].trim() };
}

export function stripAgentMetadata(content: string): string {
  const withoutFrontmatter = content.replace(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/, '');
  return withoutFrontmatter
    .split(/\r?\n/)
    .filter((line) => !/^\s*>\s*\*\*CORAL_[A-Z0-9_]+.*$/.test(line))
    .join('\n')
    .trim();
}

function stripTrailingMd(input: string): string {
  return input.endsWith('.md') ? input.slice(0, -3) : input;
}

function tryResolveExplicit(
  ref: { readonly namespace: string; readonly name: string },
  ctx: AgentResolutionContext,
): ResolutionAttempt {
  const source = namespaceSource(ref.namespace, ctx);
  if (source === null) {
    throw new AgentNamespaceNotFoundError(
      `Plugin namespace "${ref.namespace}" not found. If you just installed the plugin, restart the Coral backend (coral-cli lifecycle restart).`,
    );
  }

  const agentPath = safeJoin(source.agentsDir, `${ref.name}.md`);
  const searchedPaths = [agentPath];
  if (ctx.storage.existsSync(agentPath)) {
    return {
      result: {
        ref: { namespace: ref.namespace, name: ref.name },
        source: 'agent',
        content: ctx.storage.readFileSync(agentPath, 'utf-8'),
        path: agentPath,
      },
      searchedPaths,
    };
  }

  if (source.skillsDir !== undefined) {
    const skillPath = safeJoin(source.skillsDir, ref.name, 'SKILL.md');
    searchedPaths.push(skillPath);
    if (ctx.storage.existsSync(skillPath)) {
      return {
        result: {
          ref: { namespace: ref.namespace, name: ref.name },
          source: 'skill',
          content: ctx.storage.readFileSync(skillPath, 'utf-8'),
          path: skillPath,
        },
        searchedPaths,
      };
    }
  }

  return { result: null, searchedPaths };
}

function namespaceSource(namespace: string, ctx: AgentResolutionContext): NamespaceSource | null {
  if (namespace === 'project') {
    return { agentsDir: join(ctx.projectRoot, '.claude', 'agents') };
  }

  if (namespace === 'coral') {
    return {
      agentsDir: join(ctx.coralPluginRoot, 'agents'),
      skillsDir: join(ctx.coralPluginRoot, 'skills'),
    };
  }

  const pluginRoot = ctx.discoverPluginRoot(namespace);
  if (pluginRoot === null) return null;

  return { agentsDir: join(pluginRoot, 'agents') };
}

function safeJoin(rootDir: string, ...segments: readonly string[]): string {
  const resolvedRoot = resolve(rootDir);
  const targetPath = resolve(resolvedRoot, ...segments);
  if (targetPath !== resolvedRoot && !targetPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error('Invalid coral path');
  }
  return targetPath;
}
