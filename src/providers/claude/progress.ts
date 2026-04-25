import { isAbsolute, relative, resolve } from 'node:path';

import { isRecord } from '../../infra/json.js';
import { truncate } from '../../infra/text.js';
import type { ClaudeStreamEvent } from './types.js';

function shortPath(filePath: string, projectRoot?: string): string {
  const base = projectRoot ?? process.cwd();
  const abs = isAbsolute(filePath) ? filePath : resolve(base, filePath);
  const rel = relative(base, abs);
  return rel.startsWith('..') ? abs : rel;
}

function formatFilePath(input: Record<string, unknown>, projectRoot?: string): string {
  return typeof input.file_path === 'string' ? shortPath(input.file_path, projectRoot) : 'file';
}

function firstLine(value: unknown): string {
  return typeof value === 'string' ? value.split('\n', 1)[0] : '';
}

export function formatToolProgress(name: string, input: Record<string, unknown>, projectRoot?: string): string {
  switch (name) {
    case 'Read': {
      const file = formatFilePath(input, projectRoot);
      const offset = typeof input.offset === 'number' ? input.offset : null;
      const limit = typeof input.limit === 'number' ? input.limit : null;
      if (offset === null) return `Read(${file})`;
      if (limit === null) return `Read(${file}:${offset}+)`;
      return `Read(${file}:${offset}-${offset + limit})`;
    }
    case 'Edit': {
      const file = formatFilePath(input, projectRoot);
      const old = firstLine(input.old_string);
      const next = firstLine(input.new_string);
      if (!old && !next) return `Update(${file})`;
      return `Update(${file}, "${truncate(old, 30)}" → "${truncate(next, 30)}")`;
    }
    case 'Write': {
      return `Write(${formatFilePath(input, projectRoot)})`;
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
    case 'WebSearch':
      return `WebSearch(${truncate(typeof input.query === 'string' ? input.query : '')})`;
    case 'WebFetch':
      return `WebFetch(${truncate(typeof input.url === 'string' ? input.url : '')})`;
    default:
      return `Using: ${name}`;
  }
}

export function extractClaudeProgressMessage(event: ClaudeStreamEvent, projectRoot?: string): string | null {
  if (event.type !== 'assistant') return null;

  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name && isRecord(block.input)) {
      return formatToolProgress(block.name, block.input, projectRoot);
    }
    if (block.type === 'text') return 'Generating response...';
  }

  return null;
}
