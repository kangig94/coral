export type FaultPayload =
  | {
      kind: 'adapter_output_unparseable';
      provider: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      parseError: string;
    }
  | {
      kind: 'provider_session_unavailable';
      provider: string;
      reason: string;
    }
  | {
      kind: 'provider_request_failed';
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
    kind: 'adapter_output_unparseable',
    provider: input.provider,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    parseError: input.parseError,
  };
}

export function providerSessionUnavailable(input: ProviderSessionUnavailableInput): FaultPayload {
  return {
    kind: 'provider_session_unavailable',
    provider: input.provider,
    reason: input.reason,
  };
}

export function providerRequestFailed(input: ProviderRequestFailedInput): FaultPayload {
  return {
    kind: 'provider_request_failed',
    provider: input.provider,
    message: input.message,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
}
