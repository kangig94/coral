import { describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import {
  describeAuthorizationDecision,
  formatAuditEvent,
  writeAuditEvent,
  writeAuthorizationDecisionAudit,
} from '#src/infra/audit-log.js';
import type { Capability } from '#src/security/capability.js';
import type { Principal } from '#src/security/principal.js';
import type { Decision } from '#src/security/policy/authorize.js';

function parseAuditLine(line: string): Record<string, unknown> {
  expect(line.startsWith('audit ')).toBe(true);
  return JSON.parse(line.slice('audit '.length)) as Record<string, unknown>;
}

describe('audit-log', () => {
  it('formats structured audit events and redacts sensitive keys recursively', () => {
    const line = formatAuditEvent('example', {
      token: 'secret-token',
      bootToken: 'secret-boot-token',
      shutdownToken: 'secret-shutdown-token',
      nested: {
        apiKey: 'secret-api-key',
        visible: 'kept',
      },
      error: new Error('boom'),
    });

    const record = parseAuditLine(line);
    expect(record.schemaVersion).toBe(1);
    expect(record.event).toBe('example');
    expect(record.token).toBe('[redacted]');
    expect(record.bootToken).toBe('[redacted]');
    expect(record.shutdownToken).toBe('[redacted]');
    expect(record.nested).toEqual({
      apiKey: '[redacted]',
      visible: 'kept',
    });
    expect(record.error).toEqual({
      name: 'Error',
      message: 'boom',
    });
    expect(typeof record.recordedAt).toBe('string');
  });

  it('writes to the selected backend log level', () => {
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    try {
      writeAuditEvent('example_warn', { ok: true }, 'warn');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const record = parseAuditLine(String(warnSpy.mock.calls[0][0]));
      expect(record.event).toBe('example_warn');
      expect(record.ok).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('describes authorization decisions without credential material', () => {
    const principal: Principal = {
      subject: 'agent',
      transport: 'ipc',
      credential: { kind: 'child-handle', id: 'secret-credential-id' },
      binding: { kind: 'project', root: '/workspace/project' },
      attenuatedCaps: new Set<Capability>(['kb:read', 'jobs:read']),
    };
    const binding = { kind: 'unbound' } as const;
    const decision = {
      ok: false,
      reason: 'missing_capability',
      detail: {
        requires: 'system:shutdown',
        requestedBinding: binding,
        principalBinding: principal.binding,
        subject: principal.subject,
      },
    } satisfies Decision;

    expect(describeAuthorizationDecision(principal, 'transport.shutdown', decision, binding)).toEqual({
      principal: {
        subject: 'agent',
        transport: 'ipc',
        binding: { kind: 'project', root: '/workspace/project' },
        attenuatedCaps: ['jobs:read', 'kb:read'],
      },
      method: 'transport.shutdown',
      decision,
      binding,
    });
  });

  it('writes authorization decisions through the existing audit sink', () => {
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    try {
      const binding = { kind: 'project', root: '/workspace/project' } as const;
      const decision = {
        ok: false,
        reason: 'unauthenticated',
        detail: {
          requires: 'kb:read',
          requestedBinding: binding,
        },
      } satisfies Decision;

      writeAuthorizationDecisionAudit(null, 'kb.source.read', decision, binding);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const record = parseAuditLine(String(warnSpy.mock.calls[0][0]));
      expect(record.event).toBe('authorization_decision');
      expect(record.principal).toBeNull();
      expect(record.method).toBe('kb.source.read');
      expect(record.decision).toEqual(decision);
      expect(record.binding).toEqual(binding);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
