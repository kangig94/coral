import { execSync } from 'node:child_process';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

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
