import { execFileSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

execFileSync(npx, ['tsc', '-p', 'tsconfig.simulation.json'], { stdio: 'inherit' });
execFileSync('node', ['scripts/verify-simulation-sealing.mjs'], { stdio: 'inherit' });
