export const STORE_DATABASE_FILE_NAME = 'store.db';

export const STORE_EPOCH_METADATA_FILE_NAME = 'epoch.json';

export const STORE_LOCK_FILE_NAME = '.lock';

export const MAX_STORE_EPOCH_METADATA_BYTES = 64 * 1024;

export const MAX_STORE_EPOCH_HOLDER_BYTES = 4 * 1024;

export const EPOCH_DIRECTORY_PATTERN = /^epoch-([1-9]\d*)$/;

export const MINT_DIRECTORY_PREFIX = '.mint-';

export const MINT_PREPARATION_DIRECTORY_PREFIX = '.preparing-';

export const PRIVATE_MINT_CONSTRUCTION_PREFIX = '.coral-store-epoch-construction-';

export const REAPING_DIRECTORY_PREFIX = '.reaping-';

export const RETAINED_REAPING_DIRECTORY_PREFIX = '.retained-reaping-';

export const EPOCH_HOLDER_PREFIX = '.epoch-holder-';

export const RETIREMENT_ATTEMPT_FILE_NAME = '.retirement-attempt.v1.json';

export const STORE_EPOCH_HOLDER_PUBLICATION_ATTEMPTS = 2;

export const STORE_EPOCH_CANDIDATE_DETAIL_LIMIT = 16;

export const STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH = 512;

export const STORE_EPOCH_FAILURE_CAUSE_UNAVAILABLE = 'Store epoch failure cause is unavailable.';

// This bounds only the retry window; the following mint is not deadline-bounded. It must leave a safety
// margin below HEALTH_TIMEOUT_MS in src/transport/health.ts, so epoch read-lock waits cannot return to 5 s.
export const STORE_EPOCH_OPEN_RETRY_BUDGET_MS = 2_000;

export const STORE_EPOCH_OPEN_RETRY_INTERVAL_MS = 400;

// Measured on Node 26 / Linux 6.18: node:sqlite reports SQLITE_BUSY as errcode 5 and a removed directory as
// errcode 14 while its public code remains ERR_SQLITE_ERROR.
export const SQLITE_BUSY_ERRCODE = 5;

export const SQLITE_CORRUPT_ERRCODE = 11;

export const SQLITE_NOTADB_ERRCODE = 26;

export const SQLITE_PRIMARY_ERRCODE_MASK = 0xff;
