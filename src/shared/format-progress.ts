import { relative } from 'node:path';

function shortPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  return rel.startsWith('..') ? filePath : rel;
}

function formatFilePath(input: Record<string, unknown>): string {
  return typeof input.file_path === 'string' ? shortPath(input.file_path) : 'file';
}

function firstLine(value: unknown): string {
  return typeof value === 'string' ? value.split('\n')[0] : '';
}

export function formatToolProgress(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      const file = formatFilePath(input);
      const offset = typeof input.offset === 'number' ? input.offset : null;
      const limit = typeof input.limit === 'number' ? input.limit : null;
      if (offset === null) return `Read(${file})`;
      if (limit === null) return `Read(${file}:${offset}+)`;
      return `Read(${file}:${offset}-${offset + limit})`;
    }
    case 'Edit': {
      const file = formatFilePath(input);
      const old = firstLine(input.old_string);
      const next = firstLine(input.new_string);
      return `Edit(${file}, "${truncate(old, 30)}" → "${truncate(next, 30)}")`;
    }
    case 'Write': {
      return `Write(${formatFilePath(input)})`;
    }
    case 'Bash': {
      const description = typeof input.description === 'string' ? input.description : null;
      const command = typeof input.command === 'string' ? input.command : '';
      const text = description ?? command;
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
