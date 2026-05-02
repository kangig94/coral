#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { coralProjectDir, exitIfChildProcess, exitIfWrongFlavor, isValidSessionId, readStdin } from './lib/hook-utils.mjs';
import { renderInject } from './lib/inject-render.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!isValidSessionId(sessionId)) process.exit(0);

  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT)) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const gitRoot = projectDir ? findGitRoot(projectDir) : undefined;
  ensureCliPermission();
  if (projectDir && process.env.CORAL_AUTO_SYMLINK === '1') {
    ensureCoralSymlink(projectDir, gitRoot);
  }

  const injectContent = renderInject({
    pluginRoot: PLUGIN_ROOT,
    projectDir,
    sessionId,
    asOwner: true,
  });

  const aiAgent = process.env.AI_AGENT ?? '';
  const host = aiAgent.startsWith('claude') ? 'claude' : 'codex';

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `SessionStart:session_id=${sessionId}\nCurrent host: ${host}\n\n${injectContent}`,
    },
  }));
} catch {
  process.exit(0);
}

function findGitRoot(cwd) {
  try {
    // Bound git rev-parse against pathological mounts (NFS / WSL slow fs).
    // Fail-open: any timeout, ENOENT, or non-zero exit returns undefined.
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

function addGitignoreEntry(projectDir, entry, gitRoot) {
  try {
    const baseDir = gitRoot ?? projectDir;
    const fullEntry = gitRoot && gitRoot !== projectDir
      ? join(relative(gitRoot, projectDir), entry)
      : entry;
    const gitignore = join(baseDir, '.gitignore');
    const content = existsSync(gitignore) ? readFileSync(gitignore, 'utf-8') : '';
    if (!content.split('\n').includes(fullEntry)) {
      writeFileSync(gitignore, content + (content.endsWith('\n') || !content ? '' : '\n') + fullEntry + '\n');
    }
  } catch {
    // fail-open
  }
}

function ensureCoralSymlink(projectDir, gitRoot) {
  const claudeDir = join(projectDir, '.claude');
  if (!existsSync(claudeDir)) return; // no .claude dir — nothing to link into
  const link = join(claudeDir, 'coral');
  const target = coralProjectDir(projectDir);
  try {
    if (existsSync(link)) return;
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);
  } catch {
    return; // lost race or fs error — skip gitignore
  }
  addGitignoreEntry(projectDir, '.claude/coral', gitRoot);
}

function ensureCliPermission() {
  const rule = 'Bash(node *coral-cli*)';
  const dir = join(homedir(), '.claude');
  const file = join(dir, 'settings.json');
  try {
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
    const allow = settings.permissions?.allow ?? [];
    if (allow.includes(rule)) return;
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    settings.permissions.allow.push(rule);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    // fail-open
  }
}
