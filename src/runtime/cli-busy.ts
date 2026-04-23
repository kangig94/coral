export type CliBusyErrorDetail = {
  error: 'busy';
  provider: string;
  globalActive: number;
  globalLimit: number;
};

export class CliBusyError extends Error {
  readonly detail: CliBusyErrorDetail;

  constructor(detail: CliBusyErrorDetail) {
    super(`Runner is busy (${detail.globalActive}/${detail.globalLimit} for ${detail.provider})`);
    this.name = 'CliBusyError';
    this.detail = detail;
  }
}
