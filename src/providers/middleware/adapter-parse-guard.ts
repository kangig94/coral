import type { ProviderMiddleware } from '../contract.js';
import { adapterOutputUnparseable } from '../fault.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';

export interface ParseErrorDetail {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parseError: string;
}

function buildParseGuardFailureCause(provider: string, detail: ParseErrorDetail) {
  return adapterOutputUnparseable({
    provider,
    ...detail,
  });
}

export function adapterParseGuard(
  provider: string,
  classify: (err: unknown) => ParseErrorDetail | null,
): ProviderMiddleware {
  return (next) =>
    async function* adapterParseGuardProvider(request, runtime) {
      const startedAt = runtime.time.now();
      try {
        yield* next(request, runtime);
      } catch (err) {
        const detail = classify(err);
        if (!detail) {
          throw err;
        }

        yield {
          kind: 'terminal',
          terminal: buildJobTerminal({
            content: '',
            durationMs: Math.max(0, runtime.time.now() - startedAt),
            outcome: { kind: 'failed' },
          }),
          diagnostics: buildJobDiagnostics({}),
          failureCause: buildParseGuardFailureCause(provider, detail),
        };
      }
    };
}
