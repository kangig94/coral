#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;

  if (!pluginRoot || !existsSync(pluginRoot)) process.exit(0);

  const injectText = readFileSync(`${pluginRoot}/INJECT.md`, 'utf-8');
  const injectContent = projectDir
    ? injectText
        .replaceAll('{{CORAL_PROJECTS}}', coralProjectDir(projectDir))
        .replaceAll('{{PROJECT_SOURCE}}', resolveProjectSource(projectDir))
    : injectText;
  const additionalContext = sessionId
    ? `SessionStart:session_id=${sessionId}\n\n${injectContent}`
    : injectContent;

  if (projectDir) ensureProjectSymlink(projectDir);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
} catch {
  process.exit(0);
}

function resolveProjectSource(projectDir) {
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

function coralProjectDir(projectDir) {
  return join(homedir(), '.coral', 'projects', resolveProjectSource(projectDir).replace(/\//g, '-'));
}

function ensureProjectSymlink(projectDir) {
  try {
    const link = join(projectDir, '.claude', 'coral');
    try { if (lstatSync(link)) return; } catch { /* path doesn't exist, proceed */ }
    const target = coralProjectDir(projectDir);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);
    ensureGitignore(projectDir, '.claude/coral');
  } catch {
    // fail-open
  }
}

function ensureGitignore(projectDir, entry) {
  const gitignore = join(projectDir, '.gitignore');
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, 'utf-8');
    if (content.includes(entry)) return;
  }
  appendFileSync(gitignore, `\n${entry}\n`);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
