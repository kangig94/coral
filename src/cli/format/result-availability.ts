import type { ResultAvailability } from '../../jobs/terminal/export.js';

const failureCauses: Record<Extract<ResultAvailability, { kind: 'failed' }>['cause'], string> = {
  'repair-failed': 'writing the result file failed',
  'workflow-facts-unavailable': 'the retained workflow facts needed to rebuild the result file are unavailable',
  'source-epoch-retired': 'the source journal is no longer retained',
  'terminal-age-unknown': 'the terminal timestamp could not be verified',
  'terminal-clock-regression': 'the journal clock moved backward, so repair could not be authorized',
  'cutoff-untrusted': 'the retention clock could not be trusted',
  'terminal-unusable': 'the retained terminal outcome could not be validated',
};

export function formatResultAvailability(availability: ResultAvailability, followUp = false): string {
  switch (availability.kind) {
    case 'available':
      return `${followUp ? 'result file now available\n' : ''}Result path: ${availability.resultPath}`;
    case 'retained-away':
      return `no longer kept: past the ${availability.retentionDays}-day retention window`;
    case 'repair-pending':
      return 'the outcome above is final; Coral is writing the result file';
    case 'failed':
      return `Result file unavailable: ${failureCauses[availability.cause]}. ${availability.retryScheduled ? 'Coral will retry on its next maintenance pass.' : 'Coral cannot repair this file automatically.'}`;
  }
}
