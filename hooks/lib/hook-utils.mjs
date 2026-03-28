import { execSync } from 'node:child_process';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export function exitIfChildProcess() {
  if (process.env.CORAL_CHILD === '1') process.exit(0);
}

export function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}

export function resolveProjectSource(projectDir) {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().replace(/\.git$/, '');
    const sshPath = remote.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
    const rawPath = sshPath ?? remote.replace(/^[^:]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/^[^/]+\/+/, '');
    const segments = rawPath.split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments.at(-2)}/${segments.at(-1)}`;
  } catch {
    // fall through
  }
  return `local/${basename(projectDir)}`;
}

export function coralProjectDir(projectDir) {
  return join(homedir(), '.coral', 'projects', resolveProjectSource(projectDir).replace(/\//g, '-'));
}

export function resolveKbRoot() {
  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(homedir(), '.coral', 'kb');
}

const IDENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isOwnerId(value) {
  return typeof value === 'string' && value.length > 0 && IDENT_PATTERN.test(value);
}

export function readMemoOwnerFromFrontmatter(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;
  const ownerMatch = fmMatch[1].match(/^owner:\s*(.+)$/m);
  if (!ownerMatch) return undefined;
  const raw = ownerMatch[1].trim();
  if (!IDENT_PATTERN.test(raw)) throw new Error('Invalid owner in frontmatter');
  return raw;
}

export function sweepStale(dir, prefix, ttlMs) {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > ttlMs) try { unlinkSync(p); } catch {}
    }
  } catch {}
}
