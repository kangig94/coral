/**
 * A retained host log rides an operator response, and that response has to fit one IPC frame. Sizing this at
 * `MAX_BUFFER` made the two equal, so a host that filled its log left no room for the JSON around it — the
 * frame overflowed by roughly the envelope. The budget is therefore set on its own merits and kept well under
 * the frame, which `tests/invariants/diagnostics-fit-one-frame.test.ts` holds in place.
 *
 * One mebibyte is thousands of stderr lines. This is a tail for diagnosis, not an archive: a host that has
 * said more than this has already said enough to explain itself.
 */
export const PROVIDER_HOST_LOG_MAX_BYTES = 1024 * 1024;
export const PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT = 256;

export type ProviderHostLogEntry = Readonly<{
  seq: number;
  observedAt: number;
  stream: 'stderr';
  text: string;
  startTruncated?: true;
}>;

export type ProviderHostLogCursorSpan = Readonly<{
  startSeq: number;
  endSeq: number;
}>;

export type ProviderResponseDiagnosticResult =
  | Readonly<{ kind: 'success' }>
  | Readonly<{
      kind: 'failure';
      rpcCode: number | undefined;
      providerMessage: string | undefined;
      providerData: unknown;
    }>;

export type ProviderResponseDiagnosticFact = Readonly<{
  factSeq: number;
  generation: number;
  requestId: number;
  method: string;
  response: ProviderResponseDiagnosticResult;
  hostLog: ProviderHostLogCursorSpan;
}>;

export type ProviderResponseObservationSink = (fact: ProviderResponseDiagnosticFact) => void;

export type InspectedProviderHostLogSpan = ProviderHostLogCursorSpan &
  Readonly<{
    truncated: boolean;
    historical: readonly ProviderHostLogEntry[];
    during: readonly ProviderHostLogEntry[];
    after: readonly ProviderHostLogEntry[];
  }>;

export type InspectedProviderResponseDiagnosticFact = Omit<ProviderResponseDiagnosticFact, 'hostLog'> &
  Readonly<{
    hostLog: InspectedProviderHostLogSpan;
  }>;

export type ProviderHostDiagnosticsSnapshot = Readonly<{
  hostLog: Readonly<{
    entries: readonly ProviderHostLogEntry[];
    retainedBytes: number;
    truncatedBeforeSeq: number;
  }>;
  completedObservations: readonly InspectedProviderResponseDiagnosticFact[];
  factsTruncatedBeforeSeq: number;
}>;

export type ProviderHostDiagnosticsState = {
  hostLog: {
    entries: ProviderHostLogEntry[];
    retainedBytes: number;
    nextSeq: number;
    truncatedBeforeSeq: number;
  };
  completedObservations: ProviderResponseDiagnosticFact[];
  nextFactSeq: number;
  factsTruncatedBeforeSeq: number;
};

export function createProviderHostDiagnostics(): ProviderHostDiagnosticsState {
  return {
    hostLog: {
      entries: [],
      retainedBytes: 0,
      nextSeq: 1,
      truncatedBeforeSeq: 0,
    },
    completedObservations: [],
    nextFactSeq: 1,
    factsTruncatedBeforeSeq: 0,
  };
}

export function currentProviderHostLogSeq(state: ProviderHostDiagnosticsState): number {
  return state.hostLog.nextSeq - 1;
}

export function appendProviderHostLog(
  state: ProviderHostDiagnosticsState,
  input: Readonly<{ observedAt: number; stream: 'stderr'; text: string }>,
): ProviderHostLogEntry {
  const seq = state.hostLog.nextSeq;
  state.hostLog.nextSeq += 1;

  const inputBytes = Buffer.byteLength(input.text, 'utf8');
  if (inputBytes > PROVIDER_HOST_LOG_MAX_BYTES) {
    const text = utf8Tail(input.text, PROVIDER_HOST_LOG_MAX_BYTES);
    const entry = Object.freeze({ ...input, seq, text, startTruncated: true as const });
    state.hostLog.entries = [entry];
    state.hostLog.retainedBytes = Buffer.byteLength(text, 'utf8');
    state.hostLog.truncatedBeforeSeq = seq;
    return entry;
  }

  const entry = Object.freeze({ ...input, seq });
  state.hostLog.entries.push(entry);
  state.hostLog.retainedBytes += inputBytes;

  let evictedAny = false;
  while (state.hostLog.retainedBytes > PROVIDER_HOST_LOG_MAX_BYTES) {
    const evicted = state.hostLog.entries.shift();
    if (evicted === undefined) {
      break;
    }
    evictedAny = true;
    state.hostLog.retainedBytes -= Buffer.byteLength(evicted.text, 'utf8');
  }
  if (evictedAny) {
    state.hostLog.truncatedBeforeSeq = state.hostLog.entries[0]?.seq ?? state.hostLog.nextSeq;
  }

  return entry;
}

export function recordProviderResponseDiagnostic(
  state: ProviderHostDiagnosticsState,
  input: Readonly<{
    generation: number;
    requestId: number;
    method: string;
    response: ProviderResponseDiagnosticResult;
    startSeq: number;
    endSeq: number;
  }>,
): ProviderResponseDiagnosticFact {
  const fact = Object.freeze({
    factSeq: state.nextFactSeq,
    generation: input.generation,
    requestId: input.requestId,
    method: input.method,
    response: copyResponse(input.response),
    hostLog: Object.freeze({ startSeq: input.startSeq, endSeq: input.endSeq }),
  });
  retainProviderResponseDiagnostic(state, fact);

  return fact;
}

function retainProviderResponseDiagnostic(
  state: ProviderHostDiagnosticsState,
  fact: ProviderResponseDiagnosticFact,
): void {
  state.nextFactSeq += 1;
  state.completedObservations.push(fact);

  if (state.completedObservations.length > PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT) {
    const evicted = state.completedObservations.shift();
    if (evicted !== undefined) {
      state.factsTruncatedBeforeSeq = state.completedObservations[0]?.factSeq ?? state.nextFactSeq;
    }
  }
}

export function inspectProviderHostDiagnostics(state: ProviderHostDiagnosticsState): ProviderHostDiagnosticsSnapshot {
  const entries = Object.freeze(state.hostLog.entries.slice());
  const completedObservations = Object.freeze(
    state.completedObservations.map((fact) =>
      Object.freeze({
        ...fact,
        response: copyResponse(fact.response),
        hostLog: inspectHostLogSpan(entries, fact.hostLog, state.hostLog.truncatedBeforeSeq),
      }),
    ),
  );

  return Object.freeze({
    hostLog: Object.freeze({
      entries,
      retainedBytes: state.hostLog.retainedBytes,
      truncatedBeforeSeq: state.hostLog.truncatedBeforeSeq,
    }),
    completedObservations,
    factsTruncatedBeforeSeq: state.factsTruncatedBeforeSeq,
  });
}

function inspectHostLogSpan(
  entries: readonly ProviderHostLogEntry[],
  span: ProviderHostLogCursorSpan,
  truncatedBeforeSeq: number,
): InspectedProviderHostLogSpan {
  return Object.freeze({
    ...span,
    truncated: span.startSeq < truncatedBeforeSeq || span.endSeq < truncatedBeforeSeq,
    historical: Object.freeze(entries.filter((entry) => entry.seq <= span.startSeq)),
    during: Object.freeze(entries.filter((entry) => span.startSeq < entry.seq && entry.seq <= span.endSeq)),
    after: Object.freeze(entries.filter((entry) => entry.seq > span.endSeq)),
  });
}

function copyResponse(response: ProviderResponseDiagnosticResult): ProviderResponseDiagnosticResult {
  if (response.kind === 'success') {
    return response;
  }
  return Object.freeze({
    ...response,
    providerData: response.providerData === undefined ? undefined : structuredClone(response.providerData),
  });
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}
