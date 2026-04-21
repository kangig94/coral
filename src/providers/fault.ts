export const ADAPTER_OUTPUT_UNPARSEABLE_KIND = 'adapter_output_unparseable' as const;
export const PROVIDER_SESSION_UNAVAILABLE_KIND = 'provider_session_unavailable' as const;
export const PROVIDER_REQUEST_FAILED_KIND = 'provider_request_failed' as const;

export type FaultPayload =
  | {
      kind: typeof ADAPTER_OUTPUT_UNPARSEABLE_KIND;
      provider: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      parseError: string;
    }
  | {
      kind: typeof PROVIDER_SESSION_UNAVAILABLE_KIND;
      provider: string;
      reason: string;
    }
  | {
      kind: typeof PROVIDER_REQUEST_FAILED_KIND;
      provider: string;
      message: string;
      cause?: unknown;
    };

type AdapterOutputUnparseableInput = {
  provider: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parseError: string;
};

type ProviderSessionUnavailableInput = {
  provider: string;
  reason: string;
};

type ProviderRequestFailedInput = {
  provider: string;
  message: string;
  cause?: unknown;
};

export function adapterOutputUnparseable(input: AdapterOutputUnparseableInput): FaultPayload {
  return {
    kind: ADAPTER_OUTPUT_UNPARSEABLE_KIND,
    provider: input.provider,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    parseError: input.parseError,
  };
}

export function providerSessionUnavailable(input: ProviderSessionUnavailableInput): FaultPayload {
  return {
    kind: PROVIDER_SESSION_UNAVAILABLE_KIND,
    provider: input.provider,
    reason: input.reason,
  };
}

export function providerRequestFailed(input: ProviderRequestFailedInput): FaultPayload {
  return {
    kind: PROVIDER_REQUEST_FAILED_KIND,
    provider: input.provider,
    message: input.message,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
}
