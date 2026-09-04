import { describe, expect, it } from 'vitest';

import { shouldUseWindowsCommandShell, windowsCommandName } from '#src/infra/windows-shell.js';

describe('windows shell command helpers', () => {
  it('leaves commands unchanged and disables shell outside Windows', () => {
    expect(windowsCommandName('codex', 'linux')).toBe('codex');
    expect(shouldUseWindowsCommandShell('codex.cmd', 'linux')).toBe(false);
  });

  it('maps known bare CLI shims to .cmd on Windows', () => {
    expect(windowsCommandName('codex', 'win32')).toBe('codex.cmd');
    expect(windowsCommandName('claude', 'win32')).toBe('claude.cmd');
    expect(windowsCommandName(' codex ', 'win32')).toBe('codex.cmd');
    expect(windowsCommandName('/opt/bin/codex', 'win32')).toBe('/opt/bin/codex');
  });

  it('refuses Windows command-shell launches', () => {
    expect(() => shouldUseWindowsCommandShell('codex.cmd', 'win32')).toThrow(
      'Windows command-shell launch is unsupported',
    );
    expect(() => shouldUseWindowsCommandShell('C:\\tools\\run.bat', 'win32')).toThrow(
      'Windows command-shell launch is unsupported',
    );
    expect(() => shouldUseWindowsCommandShell('node.exe', 'win32')).toThrow(
      'Windows command-shell launch is unsupported',
    );
  });
});
