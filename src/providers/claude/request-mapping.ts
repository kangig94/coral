declare const __PLUGIN_ROOT__: string;

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isRecord } from '../../shared/utils.js';
import type { PermissionMode } from './control-protocol.js';
import type { ProviderRequest } from '../protocol.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { ProviderServerSpec } from '../types.js';
import type {
  ClaudeBootstrapSignature,
  SessionEnsureParams,
  TurnInterruptParams,
  TurnStartParams,
} from '../claude-appserver/protocol.js';
import {
  hashSortedEnv,
  normalizeControllerEnv,
  readBootstrapSignature,
  readString,
} from './shared-utils.js';

export interface ClaudePersistedContinuity extends ProviderContinuityBlob {
  brokerSessionKey?: string;
  bootstrapSignature?: ClaudeBootstrapSignature;
  envHash?: string;
  conversationRef?: string;
  brokerTurnId?: string;
}

const pluginRoot =
  typeof __PLUGIN_ROOT__ === 'string'
    ? __PLUGIN_ROOT__
    : resolve(process.cwd());
let cachedBrokerEntrypoint: string | null = null;
let envHashCache: { controllerEnv: Record<string, string> | undefined; hash: string } | null = null;

export function readClaudePersistedContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): ClaudePersistedContinuity {
  if (!isRecord(persistedContinuity)) {
    return {};
  }

  const bootstrapSignature = readBootstrapSignature(persistedContinuity.bootstrapSignature);
  return {
    brokerSessionKey: readString(persistedContinuity.brokerSessionKey),
    bootstrapSignature,
    envHash: readString(persistedContinuity.envHash),
    conversationRef: readString(persistedContinuity.conversationRef),
    brokerTurnId: readString(persistedContinuity.brokerTurnId),
  };
}

export function buildClaudeBootstrapSignature(
  request: Pick<ProviderRequest, 'cwd' | 'bypassPermissions'>,
  derivedSystemPrompt?: string,
): ClaudeBootstrapSignature {
  return {
    cwd: request.cwd,
    systemPromptHash: buildSystemPromptSignature(derivedSystemPrompt),
    permissionMode: resolveClaudePermissionMode(request.bypassPermissions),
  };
}

export function buildClaudeProviderServerSpec(): ProviderServerSpec {
  return {
    provider: 'claude',
    command: process.execPath,
    args: [resolveClaudeBrokerEntrypoint()],
    cwd: process.cwd(),
    shared: true,
    shutdownCapability: {
      method: 'broker/shutdown',
      timeoutMs: 3_000,
    },
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
    controllerEnv: normalizeControllerEnv(request.coralEnv),
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

export function buildClaudeContinuity(update: {
  brokerSessionKey?: string;
  bootstrapSignature: ClaudeBootstrapSignature;
  envHash?: string;
  conversationRef?: string;
  brokerTurnId?: string;
}): ClaudePersistedContinuity {
  return {
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
    brokerSessionKey?: string;
    bootstrapSignature?: ClaudeBootstrapSignature;
    envHash?: string;
    conversationRef?: string;
    brokerTurnId?: string;
  },
): ClaudePersistedContinuity {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  return {
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
  if (cachedBrokerEntrypoint) {
    return cachedBrokerEntrypoint;
  }

  const bundledPath = join(pluginRoot, 'bridge', 'coral-claude-appserver.cjs');
  if (existsSync(bundledPath)) {
    cachedBrokerEntrypoint = bundledPath;
    return bundledPath;
  }

  const compiledPath = join(pluginRoot, 'dist', 'providers', 'claude-appserver', 'server.js');
  if (existsSync(compiledPath)) {
    cachedBrokerEntrypoint = compiledPath;
    return compiledPath;
  }

  cachedBrokerEntrypoint = bundledPath;
  return bundledPath;
}

function buildSystemPromptSignature(derivedSystemPrompt?: string): string {
  if (typeof derivedSystemPrompt === 'string' && derivedSystemPrompt.startsWith('sha256:')) {
    return derivedSystemPrompt;
  }
  return `sha256:${createHash('sha256').update(derivedSystemPrompt ?? '').digest('hex')}`;
}

export function buildClaudeEnvHash(controllerEnv?: Record<string, string>): string {
  if (envHashCache && envHashCache.controllerEnv === controllerEnv) {
    return envHashCache.hash;
  }

  const childEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => typeof value === 'string' && !key.startsWith('CORAL_')),
    ),
    ...normalizeControllerEnv(controllerEnv),
    CORAL_CHILD: '1',
  };
  const hash = hashSortedEnv(childEnv);
  envHashCache = { controllerEnv, hash };
  return hash;
}

function resolveClaudePermissionMode(bypassPermissions: boolean): PermissionMode {
  return bypassPermissions ? 'bypassPermissions' : 'default';
}
