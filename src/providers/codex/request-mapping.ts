import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRequest } from '../../shared/types.js';
import { resolveModelTier, type EffortLevel } from '../../shared/schemas.js';
import type { ProviderServerSpec } from '../types.js';
import type { ThreadResumeParams, ThreadStartParams, TurnStartParams, UserInput } from './protocol.js';

export function buildCodexPrompt(request: Pick<ProviderRequest, 'action' | 'instruction' | 'systemPrompt' | 'prompt'>): string {
  const parts: string[] = [];
  if (request.action !== 'resume' && request.instruction) {
    parts.push(request.instruction.content);
  }
  if (request.systemPrompt) {
    parts.push(request.systemPrompt);
  }
  parts.push(request.prompt);
  return parts.join('\n\n---\n\n');
}

const CODEX_EFFORT: Record<EffortLevel, string> = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };
type CodexServiceTier = 'fast' | 'flex';

function resolveCodexSandbox(bypassPermissions: boolean): 'workspace-write' | 'danger-full-access' {
  return bypassPermissions ? 'danger-full-access' : 'workspace-write';
}

export function buildCodexProviderServerSpec(
  projectRoot: string,
  env?: Record<string, string>,
  clientVersion?: string,
): ProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: projectRoot,
    env,
    initializeRequest: {
      method: 'initialize',
      params: { clientInfo: { name: 'coral', version: clientVersion ?? 'unknown' } },
    },
  };
}

export function buildCodexTurnInput(prompt: string): UserInput[] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

const DEFAULT_CODEX_MODEL = 'gpt-5.4';

function normalizeServiceTierEnv(value: string | undefined): CodexServiceTier | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized === '1') return 'fast';
  if (normalized === '0') return 'flex';
  return undefined;
}

/**
 * Read `service_tier` from the top level of ~/.codex/config.toml.
 * Profile-scoped values under `[profiles.xxx]` are intentionally ignored —
 * the scan halts at the first section header.
 */
function readCodexConfigServiceTier(): CodexServiceTier | undefined {
  try {
    const configPath = join(homedir(), '.codex', 'config.toml');
    const content = readFileSync(configPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (/^\s*\[/.test(line)) {
        break;
      }
      const match = line.match(/^\s*service_tier\s*=\s*["']?(fast|flex)["']?\s*(#.*)?$/i);
      if (match) {
        return match[1].toLowerCase() as CodexServiceTier;
      }
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'EACCES') {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[coral] Could not read service_tier from ~/.codex/config.toml: ${message}. Set CORAL_CODEX_FAST=fast|flex to override.\n`);
    }
    return undefined;
  }

  return undefined;
}

function resolveCodexServiceTier(request: ProviderRequest): CodexServiceTier | undefined {
  const rawEnvTier = request.coralEnv['CORAL_CODEX_FAST'];
  // Blank env = unset; fall through to config.toml. Non-blank but unrecognized = explicit rejection (no fallback).
  if (rawEnvTier === undefined || rawEnvTier.trim() === '') {
    return readCodexConfigServiceTier();
  }
  return normalizeServiceTierEnv(rawEnvTier);
}

function resolveCodexModel(request: ProviderRequest): string {
  return resolveModelTier(request.model) ?? request.coralEnv['CORAL_CODEX_MODEL'] ?? DEFAULT_CODEX_MODEL;
}

export function mapThreadStartParams(request: ProviderRequest): ThreadStartParams {
  const tier = resolveCodexServiceTier(request);
  return {
    cwd: request.cwd,
    model: resolveCodexModel(request),
    approvalPolicy: 'never',
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    ephemeral: false,
    ...(tier && { serviceTier: tier }),
  };
}

export function mapThreadResumeParams(request: ProviderRequest, threadId: string): ThreadResumeParams {
  const tier = resolveCodexServiceTier(request);
  return {
    threadId,
    cwd: request.cwd,
    model: resolveCodexModel(request),
    approvalPolicy: 'never',
    // Codex merge_persisted_resume_metadata() does not restore sandbox from stored
    // ThreadMetadata — omitting sandbox causes a downgrade to the config default (read-only).
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    ...(tier && { serviceTier: tier }),
  };
}

export function mapTurnStartParams(request: ProviderRequest, threadId: string): TurnStartParams {
  const tier = resolveCodexServiceTier(request);
  return {
    threadId,
    input: buildCodexTurnInput(buildCodexPrompt(request)),
    model: resolveCodexModel(request),
    effort: CODEX_EFFORT[request.effort],
    ...(tier && { serviceTier: tier }),
  };
}
