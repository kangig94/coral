import type { ResultAvailability } from '../../jobs/terminal/export.js';

export function formatResultAvailability(availability: ResultAvailability, followUp = false): string {
  switch (availability.kind) {
    case 'available':
      return `${followUp ? 'result file now available\n' : ''}Result path: ${availability.resultPath}`;
    case 'retained-away':
      return `no longer kept: past the ${availability.retentionDays}-day retention window`;
    case 'repair-pending':
      return 'the outcome above is final; Coral is writing the result file';
    case 'failed':
      return `Result file failed: ${availability.cause}; ${availability.retryScheduled ? 'Coral retries on its next maintenance pass' : `not repaired: ${availability.cause}`}`;
  }
}
