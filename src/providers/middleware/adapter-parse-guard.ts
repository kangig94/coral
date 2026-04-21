import type { ProviderMiddleware } from '../contract.js';
import { adapterOutputUnparseable } from '../fault.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';

export interface ParseErrorDetail {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parseError: string;
}

export function adapterParseGuard(
  provider: string,
  classify: (err: unknown) => ParseErrorDetail | null,
): ProviderMiddleware {
  return (next) =>
    async function* adapterParseGuardProvider(request, runtime) {
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
            outcome: {
              kind: 'failed',
              fault: adapterOutputUnparseable({
                provider,
                ...detail,
              }),
            },
          }),
          diagnostics: buildJobDiagnostics({}),
        };
      }
    };
}
