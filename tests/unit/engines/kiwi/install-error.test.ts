import { describe, expect, it } from 'vitest';

import { isInstallPathUnwritableError, kiwiInstallError } from '#src/engines/kiwi/install-error.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('Kiwi install errors', () => {
  it.each(['EACCES', 'EPERM', 'EROFS', 'ENOSPC'])('classifies %s as an unwritable install path', (code) => {
    expect(isInstallPathUnwritableError(errno(code))).toBe(true);
  });

  it('does not classify unrelated or non-error values as unwritable paths', () => {
    expect(isInstallPathUnwritableError(errno('ETIMEDOUT'))).toBe(false);
    expect(isInstallPathUnwritableError(new Error('plain failure'))).toBe(false);
    expect(isInstallPathUnwritableError({ code: 'EACCES' })).toBe(false);
  });

  it('uses the canonical structured setup-error registry', () => {
    expect(kiwiInstallError('expansion_install_artifact_failed', { name: 'kiwi', detail: 'broken' })).toEqual({
      status: 'error',
      code: 'expansion_install_artifact_failed',
      userMessage: 'Coral could not install the runtime artifacts for kiwi.',
      remediation: expect.stringContaining('coral-cli expansion equip kiwi'),
      context: { name: 'kiwi', detail: 'broken' },
    });
  });
});
