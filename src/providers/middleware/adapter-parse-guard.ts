import type { ProviderMiddleware } from '../contract.js';
import { adapterOutputUnparseable } from '../fault.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';

export interface ParseErrorDetail {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parseError: string;
}

const ADAPTER_PARSE_GUARD_FAULT_KIND = 'adapter_output_unparseable' as const;

function buildParseGuardFault(provider: string, detail: ParseErrorDetail) {
  const fault = adapterOutputUnparseable({
    provider,
    ...detail,
  });
  if (fault.kind !== ADAPTER_PARSE_GUARD_FAULT_KIND) {
    throw new Error('adapterParseGuard emitted an unexpected fault kind.');
  }
  return fault;
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
              fault: buildParseGuardFault(provider, detail),
            },
          }),
          diagnostics: buildJobDiagnostics({}),
        };
      }
    };
}
