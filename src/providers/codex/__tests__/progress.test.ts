import { describe, expect, it } from 'vitest';
import { extractProgressMessage } from '../progress.js';
import type { CodexThreadEvent } from '../types.js';

const projectRoot = '/repo';

function fileChangeEvent(path?: string, kind = 'modified'): CodexThreadEvent {
  const changes: Array<{ path: string; kind: string }> = path === undefined ? [] : [{ path, kind }];
  return {
    type: 'item.completed',
    item: {
      id: 'item-1',
      type: 'file_change',
      changes,
      status: 'completed',
    },
  };
}

function commandEvent(command: string): CodexThreadEvent {
  return {
    type: 'item.completed',
    item: {
      id: 'item-2',
      type: 'command_execution',
      command,
      aggregated_output: '',
      exit_code: 0,
      status: 'completed',
    },
  };
}

describe('extractProgressMessage', () => {
  it('formats modified file_change as Edit', () => {
    expect(extractProgressMessage(fileChangeEvent('/repo/src/main.ts'), projectRoot)).toBe('Update(src/main.ts)');
  });

  it('formats created file_change as Write', () => {
    expect(extractProgressMessage(fileChangeEvent('/repo/src/new.ts', 'created'), projectRoot)).toBe('Write(src/new.ts)');
  });

  it('formats file_change path outside projectRoot as absolute', () => {
    expect(extractProgressMessage(fileChangeEvent('/tmp/scratch.ts'), projectRoot)).toBe('Update(/tmp/scratch.ts)');
  });

  it('formats relative file_change path against projectRoot', () => {
    expect(extractProgressMessage(fileChangeEvent('src/main.ts'), projectRoot)).toBe('Update(src/main.ts)');
  });

  it('falls back to "Update(file)" when file_change path is missing', () => {
    expect(extractProgressMessage(fileChangeEvent(undefined), projectRoot)).toBe('Update(file)');
  });

  it('formats command_execution file reads relative to projectRoot', () => {
    expect(extractProgressMessage(commandEvent('cat /repo/src/main.ts'), projectRoot)).toBe('Read(src/main.ts)');
  });

  it('formats shell-wrapped command_execution file reads relative to projectRoot', () => {
    const command = '/usr/bin/zsh -lc "cd /repo && cat src/providers/codex/progress.ts"';
    expect(extractProgressMessage(commandEvent(command), projectRoot)).toBe('Read(src/providers/codex/progress.ts)');
  });

  it('keeps non-file command_execution progress unchanged', () => {
    expect(extractProgressMessage(commandEvent('rg -n "extractProgressMessage" src'), projectRoot))
      .toBe('Grep(extractProgressMessage)');
    expect(extractProgressMessage(commandEvent('ls -la'), projectRoot)).toBe('Bash(ls -la)');
  });
});
