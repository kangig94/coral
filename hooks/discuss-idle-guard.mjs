#!/usr/bin/env node

/**
 * TeammateIdle hook — blocks idle when a discuss agent has a pending action.
 * Checks session state for pending bids, speeches, or votes.
 * Fail-open: any error exits silently (allow idle).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const teammateName = input.teammate_name || '';
  const teamName = input.team_name || '';

  // Only process dc- teammates
  if (!teammateName.startsWith('dc-')) process.exit(0);

  // Require discuss directory
  const discussDir = join(process.cwd(), '.claude', 'coral', 'discuss');
  if (!existsSync(discussDir)) process.exit(0);

  // Strip Agent Teams dedup suffix then dc- prefix: dc-architect-1 → architect
  const agentName = teammateName.replace(/-\d+$/, '').replace(/^dc-/, '');

  // Extract session_id from team_name (coral-dc-{session_id})
  if (!teamName.startsWith('coral-dc-')) process.exit(0);
  const sessionId = teamName.slice('coral-dc-'.length);

  // Resolve session directory
  const sessionDir = readdirSync(discussDir).find(d => d.startsWith(`${sessionId}_`) || d.startsWith(`${sessionId}-`));
  if (!sessionDir) process.exit(0);

  const statePath = join(discussDir, sessionDir, 'state.json');
  if (!existsSync(statePath)) process.exit(0);

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const { status, current_speaker, pending_bidders = [] } = state;

  // Bidding: agent hasn't bid yet
  if (status === 'bidding' && pending_bidders.includes(agentName)) {
    process.stderr.write('Call `discuss` with op: "bid" to submit your bid.\n');
    process.exit(2);
  }

  // Speaking: agent has the floor
  if (status === 'speaking' && current_speaker === agentName) {
    process.stderr.write('Call `discuss` with op: "speak" to deliver your speech.\n');
    process.exit(2);
  }

  // Voting: agent hasn't voted yet
  if (status === 'voting' && pending_bidders.includes(agentName)) {
    process.stderr.write('Termination vote: call `discuss` with op: "bid" - 0=agree to end, 1=disagree.\n');
    process.exit(2);
  }

  process.exit(0);
} catch {
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
