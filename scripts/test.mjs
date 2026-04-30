import { spawn } from 'child_process';

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${cmd}`))));
    child.on('error', reject);
  });
}

const commands = [];
commands.push('npx tsc -p tests/types/tsconfig.json');
commands.push('npx vitest run --config vitest/default.ts');
commands.push('npx vitest run --config vitest/simulation.ts');

try {
  for (const command of commands) {
    await runAsync(command);
  }
} catch {
  process.exit(1);
}
