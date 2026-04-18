#!/usr/bin/env node

import { failOpen, logHookLine, readStdin } from './lib/hook-utils.mjs';

await failOpen(async () => {
  JSON.parse((await readStdin()) || '{}');
  logHookLine('post-compact', 'stub: no-op until Phase 7 rewrites to read projection_jobs');
}, 'post-compact');
