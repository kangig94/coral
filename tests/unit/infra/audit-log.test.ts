import { describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { formatAuditEvent, writeAuditEvent } from '#src/infra/audit-log.js';

function parseAuditLine(line: string): Record<string, unknown> {
  expect(line.startsWith('audit ')).toBe(true);
  return JSON.parse(line.slice('audit '.length)) as Record<string, unknown>;
}

describe('audit-log', () => {
  it('formats structured audit events and redacts sensitive keys recursively', () => {
    const line = formatAuditEvent('example', {
      token: 'secret-token',
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
});
