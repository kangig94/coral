import { basename } from 'node:path';

export function formatToolProgress(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      const file = typeof input.file_path === 'string' ? basename(input.file_path) : 'file';
      const offset = typeof input.offset === 'number' ? input.offset : null;
      const limit = typeof input.limit === 'number' ? input.limit : null;
      if (offset !== null && limit !== null) return `Read(${file}:${offset}-${offset + limit})`;
      if (offset !== null) return `Read(${file}:${offset}+)`;
      return `Read(${file})`;
    }
    case 'Edit': {
      const file = typeof input.file_path === 'string' ? basename(input.file_path) : 'file';
      const old = typeof input.old_string === 'string' ? input.old_string.split('\n')[0] : '';
      const next = typeof input.new_string === 'string' ? input.new_string.split('\n')[0] : '';
      return `Edit(${file}, "${truncate(old, 30)}" → "${truncate(next, 30)}")`;
    }
    case 'Write': {
      const file = typeof input.file_path === 'string' ? basename(input.file_path) : 'file';
      return `Write(${file})`;
    }
    case 'Bash': {
      const text = typeof input.description === 'string'
        ? input.description
        : (typeof input.command === 'string' ? input.command : '');
      return `Bash(${truncate(text)})`;
    }
    case 'Grep':
      return `Grep(${typeof input.pattern === 'string' ? input.pattern : ''})`;
    case 'Glob':
      return `Glob(${typeof input.pattern === 'string' ? input.pattern : ''})`;
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return `Agent(${truncate(desc)})`;
    }
    default:
      return `Using: ${name}`;
  }
}

export function truncate(text: string, maxLen = 80): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
