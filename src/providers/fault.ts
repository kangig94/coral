export const SESSION_ADAPTER_UNPARSEABLE_EVENT = 'session.adapter_unparseable' as const;
export const SESSION_PROVIDER_FAILED_EVENT = 'session.provider_failed' as const;

export type ProviderFailureCause =
  | {
      type: typeof SESSION_ADAPTER_UNPARSEABLE_EVENT;
      body: {
        provider: string;
        exitCode: number | null;
        stdout: string;
        stderr: string;
        parseError: string;
      };
    }
  | {
      type: typeof SESSION_PROVIDER_FAILED_EVENT;
      body: {
        provider: string;
        reason: 'session_unavailable' | 'request_failed';
        message: string;
      };
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

export function adapterOutputUnparseable(input: AdapterOutputUnparseableInput): ProviderFailureCause {
  return {
    type: SESSION_ADAPTER_UNPARSEABLE_EVENT,
    body: {
      provider: input.provider,
      exitCode: input.exitCode,
      stdout: input.stdout,
      stderr: input.stderr,
      parseError: input.parseError,
    },
  };
}

export function providerSessionUnavailable(input: ProviderSessionUnavailableInput): ProviderFailureCause {
  return {
    type: SESSION_PROVIDER_FAILED_EVENT,
    body: {
      provider: input.provider,
      reason: 'session_unavailable',
      message: input.reason,
    },
  };
}

export function providerRequestFailed(input: ProviderRequestFailedInput): ProviderFailureCause {
  return {
    type: SESSION_PROVIDER_FAILED_EVENT,
    body: {
      provider: input.provider,
      reason: 'request_failed',
      message: input.message,
    },
  };
}
