declare const __PLUGIN_ROOT__: string;

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isRecord } from '../../shared/mcp-utils.js';
import type { ProviderContinuityBlob, ProviderRequest } from '../../shared/types.js';
import type { ProviderServerSpec } from '../types.js';
import type {
  ClaudeBootstrapSignature,
  SessionEnsureParams,
  TurnInterruptParams,
  TurnStartParams,
} from '../claude-appserver/protocol.js';

export interface ClaudePersistedContinuity extends ProviderContinuityBlob {
  serverKey?: string;
  brokerSessionKey?: string;
  bootstrapSignature?: ClaudeBootstrapSignature;
  envHash?: string;
  conversationRef?: string;
  brokerTurnId?: string;
}

export const CLAUDE_PROVIDER_SERVER_KEY = 'claude';

const pluginRoot =
  typeof __PLUGIN_ROOT__ === 'string'
    ? __PLUGIN_ROOT__
    : resolve(process.cwd());

export function readClaudePersistedContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): ClaudePersistedContinuity {
  if (!isRecord(persistedContinuity)) {
    return {};
  }

  const bootstrapSignature = readBootstrapSignature(persistedContinuity.bootstrapSignature);
  return {
    serverKey: readString(persistedContinuity.serverKey),
    brokerSessionKey: readString(persistedContinuity.brokerSessionKey),
    bootstrapSignature,
    envHash: readString(persistedContinuity.envHash),
    conversationRef: readString(persistedContinuity.conversationRef),
    brokerTurnId: readString(persistedContinuity.brokerTurnId),
  };
}

export function hasClaudePersistentContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): boolean {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  return Boolean(
    continuity.serverKey ??
      continuity.brokerSessionKey ??
      continuity.bootstrapSignature ??
      continuity.envHash ??
      continuity.conversationRef ??
      continuity.brokerTurnId,
  );
}

export function buildClaudeBootstrapSignature(
  request: Pick<ProviderRequest, 'cwd' | 'bypassPermissions'>,
  derivedSystemPrompt?: string,
): ClaudeBootstrapSignature {
  return {
    cwd: request.cwd ?? process.cwd(),
    systemPromptHash: buildSystemPromptSignature(derivedSystemPrompt),
    permissionMode: resolveClaudePermissionMode(request.bypassPermissions),
  };
}

export function buildClaudeProviderServerSpec(
  _request: Pick<ProviderRequest, 'sessionId' | 'cwd' | 'bypassPermissions' | 'coralEnv'>,
  _derivedSystemPrompt?: string,
  _persistedContinuity?: ProviderContinuityBlob,
): ProviderServerSpec {
  return {
    provider: 'claude',
    key: CLAUDE_PROVIDER_SERVER_KEY,
    command: process.execPath,
    args: [resolveClaudeBrokerEntrypoint()],
    cwd: process.cwd(),
    shared: true,
  };
}

export function mapSessionEnsureParams(
  request: Pick<ProviderRequest, 'cwd' | 'bypassPermissions' | 'conversationRef' | 'coralEnv'>,
  derivedSystemPrompt?: string,
  persistedContinuity?: ProviderContinuityBlob,
): SessionEnsureParams {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  const bootstrapSignature = buildClaudeBootstrapSignature(request, derivedSystemPrompt);
  return {
    ...bootstrapSignature,
    brokerSessionKey: continuity.brokerSessionKey,
    conversationRef: continuity.conversationRef ?? request.conversationRef,
    controllerEnv: normalizeClaudeControllerEnv(request.coralEnv),
    systemPrompt: derivedSystemPrompt,
  };
}

export function mapTurnStartParams(
  request: Pick<ProviderRequest, 'model'>,
  prompt: string,
  brokerSessionKey: string,
): TurnStartParams {
  return {
    brokerSessionKey,
    brokerTurnId: randomUUID(),
    prompt,
    model: request.model,
  };
}

export function mapInterruptParams(
  brokerSessionKey: string,
  brokerTurnId?: string,
): TurnInterruptParams {
  return brokerTurnId ? { brokerSessionKey, brokerTurnId } : { brokerSessionKey };
}

export function findClaudeBootstrapDrift(
  request: Pick<ProviderRequest, 'cwd' | 'bypassPermissions'>,
  derivedSystemPrompt: string | undefined,
  persistedContinuity: ProviderContinuityBlob | undefined,
): {
  expected: ClaudeBootstrapSignature;
  actual: ClaudeBootstrapSignature;
} | null {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  if (!continuity.bootstrapSignature) {
    return null;
  }

  const actual = buildClaudeBootstrapSignature(request, derivedSystemPrompt);
  if (sameBootstrapSignature(continuity.bootstrapSignature, actual)) {
    return null;
  }

  return {
    expected: continuity.bootstrapSignature,
    actual,
  };
}

export function buildClaudeContinuity(update: {
  serverKey: string;
  brokerSessionKey?: string;
  bootstrapSignature: ClaudeBootstrapSignature;
  envHash?: string;
  conversationRef?: string;
  brokerTurnId?: string;
}): ClaudePersistedContinuity {
  return {
    serverKey: update.serverKey,
    ...(update.brokerSessionKey ? { brokerSessionKey: update.brokerSessionKey } : {}),
    bootstrapSignature: update.bootstrapSignature,
    ...(update.envHash ? { envHash: update.envHash } : {}),
    ...(update.conversationRef ? { conversationRef: update.conversationRef } : {}),
    ...(update.brokerTurnId ? { brokerTurnId: update.brokerTurnId } : {}),
  };
}

export function withClaudeContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  update: {
    serverKey?: string;
    brokerSessionKey?: string;
    bootstrapSignature?: ClaudeBootstrapSignature;
    envHash?: string;
    conversationRef?: string;
    brokerTurnId?: string;
  },
): ClaudePersistedContinuity {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  return {
    ...(continuity.serverKey || update.serverKey ? { serverKey: update.serverKey ?? continuity.serverKey } : {}),
    ...(continuity.brokerSessionKey || update.brokerSessionKey
      ? { brokerSessionKey: update.brokerSessionKey ?? continuity.brokerSessionKey }
      : {}),
    ...(continuity.bootstrapSignature || update.bootstrapSignature
      ? {
          bootstrapSignature: update.bootstrapSignature ?? continuity.bootstrapSignature,
        }
      : {}),
    ...(continuity.envHash || update.envHash ? { envHash: update.envHash ?? continuity.envHash } : {}),
    ...(continuity.conversationRef || update.conversationRef
      ? { conversationRef: update.conversationRef ?? continuity.conversationRef }
      : {}),
    ...(continuity.brokerTurnId || update.brokerTurnId
      ? { brokerTurnId: update.brokerTurnId ?? continuity.brokerTurnId }
      : {}),
  };
}

function resolveClaudeBrokerEntrypoint(): string {
  const bundledPath = join(pluginRoot, 'bridge', 'coral-claude-appserver.cjs');
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  const compiledPath = join(pluginRoot, 'dist', 'providers', 'claude-appserver', 'server.js');
  if (existsSync(compiledPath)) {
    return compiledPath;
  }

  return bundledPath;
}

function buildSystemPromptSignature(derivedSystemPrompt?: string): string {
  if (typeof derivedSystemPrompt === 'string' && derivedSystemPrompt.startsWith('sha256:')) {
    return derivedSystemPrompt;
  }
  return `sha256:${createHash('sha256').update(derivedSystemPrompt ?? '').digest('hex')}`;
}

export function buildClaudeEnvHash(controllerEnv?: Record<string, string>): string {
  const childEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => typeof value === 'string' && !key.startsWith('CORAL_')),
    ),
    ...normalizeClaudeControllerEnv(controllerEnv),
    CORAL_CHILD: '1',
  };
  const sortedEntries = Object.entries(childEnv)
    .filter(([key]) => key !== 'CORAL_CHILD')
    .sort(([left], [right]) => left.localeCompare(right));
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex')}`;
}

function resolveClaudePermissionMode(bypassPermissions: boolean): string {
  return bypassPermissions ? 'bypass' : 'default';
}

function sameBootstrapSignature(left: ClaudeBootstrapSignature, right: ClaudeBootstrapSignature): boolean {
  return (
    left.cwd === right.cwd &&
    left.systemPromptHash === right.systemPromptHash &&
    left.permissionMode === right.permissionMode
  );
}

function readBootstrapSignature(value: unknown): ClaudeBootstrapSignature | undefined {
  if (
    !isRecord(value) ||
    typeof value.cwd !== 'string' ||
    typeof value.systemPromptHash !== 'string' ||
    typeof value.permissionMode !== 'string'
  ) {
    return undefined;
  }

  return {
    cwd: value.cwd,
    systemPromptHash: value.systemPromptHash,
    permissionMode: value.permissionMode,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeClaudeControllerEnv(controllerEnv?: Record<string, string>): Record<string, string> {
  if (!controllerEnv) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(controllerEnv).filter(([, value]) => typeof value === 'string'),
  );
}
