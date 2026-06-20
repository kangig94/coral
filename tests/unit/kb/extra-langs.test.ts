import { describe, expect, it } from 'vitest';

import {
  CORAL_KB_EXTRA_LANGS_ENV,
  parseDeclaredKbAnalyzers,
  readDeclaredKbAnalyzersFromEnv,
} from '#src/kb/extra-langs.js';

describe('KB declared analyzer config', () => {
  it('parses empty and unset values as no declared analyzers', () => {
    expect(parseDeclaredKbAnalyzers(undefined)).toEqual([]);
    expect(parseDeclaredKbAnalyzers('')).toEqual([]);
    expect(parseDeclaredKbAnalyzers(' , , ')).toEqual([]);
  });

  it('normalizes casing and comma-separated whitespace', () => {
    expect(parseDeclaredKbAnalyzers('ko')).toEqual(['ko']);
    expect(parseDeclaredKbAnalyzers('KO')).toEqual(['ko']);
    expect(parseDeclaredKbAnalyzers(' Ko , KO , ko ')).toEqual(['ko']);
  });

  it('ignores unknown analyzer codes with one warning per code', () => {
    const warnings: string[] = [];

    expect(parseDeclaredKbAnalyzers(' ko,zz, ZZ,fr ', (message) => warnings.push(message))).toEqual(['ko']);
    expect(warnings).toEqual([
      `${CORAL_KB_EXTRA_LANGS_ENV}: unknown language code "zz" has no registered analyzer; ignoring.`,
      `${CORAL_KB_EXTRA_LANGS_ENV}: unknown language code "fr" has no registered analyzer; ignoring.`,
    ]);
  });

  it('reads the raw value through the runtime env port shape', () => {
    expect(
      readDeclaredKbAnalyzersFromEnv({
        get: (key) => (key === CORAL_KB_EXTRA_LANGS_ENV ? ' KO ' : undefined),
      }),
    ).toEqual(['ko']);
  });
});
