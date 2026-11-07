import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

process.env.CORAL_TEST_TIER = 'unit';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.sql')) {
      return {
        format: 'module',
        source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
await import('./jobs-list-latency.ts');
