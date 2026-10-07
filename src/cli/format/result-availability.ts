import type { ResultAvailability } from '../../jobs/terminal/export.js';

export function formatResultAvailability(availability: ResultAvailability): string {
  switch (availability.kind) {
    case 'available':
      return `Result path: ${availability.resultPath}`;
    case 'retained-away':
      return `no longer kept: past the ${availability.retentionDays}-day retention window`;
    case 'pending':
      return 'Result file pending; Coral will attempt publication on its next maintenance pass.';
    case 'failed':
      return `Result file unavailable: ${availability.reason}. Coral cannot repair this file automatically.`;
  }
}
