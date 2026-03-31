declare const __PLUGIN_ROOT__: string;

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  bootstrapSignature?: ClaudeBootstrapSignature;
  conversationRef?: string;
  brokerTurnId?: string;
}

const pluginRoot =
  typeof __PLUGIN_ROOT__ === 'string'
    ? __PLUGIN_ROOT__
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function readClaudePersistedContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): ClaudePersistedContinuity {
  if (!isRecord(persistedContinuity)) {
    return {};
  }

  const bootstrapSignature = readBootstrapSignature(persistedContinuity.bootstrapSignature);
  return {
    serverKey: readString(persistedContinuity.serverKey),
    bootstrapSignature,
    conversationRef: readString(persistedContinuity.conversationRef),
    brokerTurnId: readString(persistedContinuity.brokerTurnId),
  };
}

export function hasClaudePersistentContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): boolean {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  return Boolean(
    continuity.serverKey ?? continuity.bootstrapSignature ?? continuity.conversationRef ?? continuity.brokerTurnId,
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

export function buildClaudeSessionKey(
  request: Pick<ProviderRequest, 'sessionId' | 'cwd' | 'bypassPermissions'>,
  derivedSystemPrompt?: string,
  persistedContinuity?: ProviderContinuityBlob,
): string {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  if (continuity.serverKey && continuity.serverKey.startsWith(`claude:${request.sessionId}:`)) {
    return continuity.serverKey;
  }

  const signature = continuity.bootstrapSignature ?? buildClaudeBootstrapSignature(request, derivedSystemPrompt);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(signature))
    .digest('hex')
    .slice(0, 16);
  return `claude:${request.sessionId}:${fingerprint}`;
}

export function buildClaudeProviderServerSpec(
  request: Pick<ProviderRequest, 'sessionId' | 'cwd' | 'bypassPermissions' | 'coralEnv'>,
  derivedSystemPrompt?: string,
  persistedContinuity?: ProviderContinuityBlob,
): ProviderServerSpec {
  return {
    provider: 'claude',
    key: buildClaudeSessionKey(request, derivedSystemPrompt, persistedContinuity),
    command: process.execPath,
    args: [resolveClaudeBrokerEntrypoint()],
    cwd: request.cwd ?? process.cwd(),
    env: request.coralEnv,
  };
}

export function mapSessionEnsureParams(
  request: Pick<ProviderRequest, 'cwd' | 'bypassPermissions' | 'conversationRef'>,
  derivedSystemPrompt?: string,
  persistedContinuity?: ProviderContinuityBlob,
): SessionEnsureParams {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  const bootstrapSignature = buildClaudeBootstrapSignature(request, derivedSystemPrompt);
  return {
    ...bootstrapSignature,
    conversationRef: continuity.conversationRef ?? request.conversationRef,
    systemPrompt: derivedSystemPrompt,
  };
}

export function mapTurnStartParams(
  request: Pick<ProviderRequest, 'model'>,
  prompt: string,
): TurnStartParams {
  return {
    brokerTurnId: randomUUID(),
    prompt,
    model: request.model,
  };
}

export function mapInterruptParams(brokerTurnId?: string): TurnInterruptParams {
  return brokerTurnId ? { brokerTurnId } : {};
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
  bootstrapSignature: ClaudeBootstrapSignature;
  conversationRef?: string;
  brokerTurnId?: string;
}): ClaudePersistedContinuity {
  return {
    serverKey: update.serverKey,
    bootstrapSignature: update.bootstrapSignature,
    ...(update.conversationRef ? { conversationRef: update.conversationRef } : {}),
    ...(update.brokerTurnId ? { brokerTurnId: update.brokerTurnId } : {}),
  };
}

export function withClaudeContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  update: {
    serverKey?: string;
    bootstrapSignature?: ClaudeBootstrapSignature;
    conversationRef?: string;
    brokerTurnId?: string;
  },
): ClaudePersistedContinuity {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  return {
    ...(continuity.serverKey || update.serverKey ? { serverKey: update.serverKey ?? continuity.serverKey } : {}),
    ...(continuity.bootstrapSignature || update.bootstrapSignature
      ? {
          bootstrapSignature: update.bootstrapSignature ?? continuity.bootstrapSignature,
        }
      : {}),
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
