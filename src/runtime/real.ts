import { CoralSetupError } from './errors.js';
import type { Runtime } from './ports.js';

export function createRealRuntime(): Runtime {
  throw new CoralSetupError({
    code: 'runtime_not_implemented',
    userMessage: 'src/runtime/real.ts is a Phase 1 placeholder — call site should not reach it in Phase 0.',
    remediation:
      'Phase 0 uses src/execution/runtime.ts as the live real-runtime. Migrate callers here only during the Phase 1 cutover.',
  });
}
