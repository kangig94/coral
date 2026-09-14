import type { StorageActuator } from '../infra/storage-actuator.js';

const SETTLEMENT_AUTHORITY_BRAND: unique symbol = Symbol('SettlementAuthority');

type SettlementLease = Readonly<{
  maintain(): void;
  assertOwned(): void;
}>;

type CloseableResource = Readonly<{
  close(): void;
}>;

export class SettlementAuthorityLost extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SettlementAuthorityLost';
  }
}

export type SettlementAuthority = Readonly<{
  readonly actuator: StorageActuator;
  hold(): void;
  openDatabase<T extends CloseableResource>(open: () => T): T;
  transferDatabase<T extends CloseableResource>(database: T): T;
  [SETTLEMENT_AUTHORITY_BRAND]: true;
}>;

function revocableActuator(weaker: StorageActuator, hold: () => void): StorageActuator {
  return {
    writeWholeFile: (path, data, options) => {
      hold();
      weaker.writeWholeFile(path, data, options);
    },
    rename: (oldPath, newPath) => {
      hold();
      weaker.rename(oldPath, newPath);
    },
    link: (existingPath, newPath) => {
      hold();
      weaker.link(existingPath, newPath);
    },
    makeDirectory: (path, options) => {
      hold();
      weaker.makeDirectory(path, options);
    },
    remove: (path, options) => {
      hold();
      weaker.remove(path, options);
    },
    createFile: (path, flags, mode) => {
      hold();
      return weaker.createFile(path, flags, mode);
    },
    read: (fd, buffer, offset, length, position) => {
      hold();
      return weaker.read(fd, buffer, offset, length, position);
    },
    write: (fd, buffer, offset, length, position) => {
      hold();
      return weaker.write(fd, buffer, offset, length, position);
    },
    syncFile: (fd) => {
      hold();
      weaker.syncFile(fd);
    },
    appendWholeFile: (path, data) => {
      hold();
      weaker.appendWholeFile(path, data);
    },
    appendWholeFileDurable: (path, data) => {
      hold();
      return weaker.appendWholeFileDurable(path, data);
    },
    appendWholeFileCanonical: (path, data, options) => {
      hold();
      return weaker.appendWholeFileCanonical(path, data, options);
    },
    removeDirectory: (path) => {
      hold();
      weaker.removeDirectory(path);
    },
    unlink: (path) => {
      hold();
      weaker.unlink(path);
    },
    tryCreateWholeFile: (path, data, options) => {
      hold();
      return weaker.tryCreateWholeFile(path, data, options);
    },
    writeWholeFileAtomic: (path, data, options) => {
      hold();
      return weaker.writeWholeFileAtomic(path, data, options);
    },
    writeWholeFileDurable: (path, data, options) => {
      hold();
      return weaker.writeWholeFileDurable(path, data, options);
    },
    syncDirectory: (path) => {
      hold();
      return weaker.syncDirectory(path);
    },
    setMode: (path, mode) => {
      hold();
      weaker.setMode(path, mode);
    },
  } as StorageActuator;
}

class RevokingSettlementAuthority implements SettlementAuthority {
  readonly actuator: StorageActuator;
  readonly [SETTLEMENT_AUTHORITY_BRAND] = true;

  readonly #leases: readonly SettlementLease[];
  readonly #resources = new Map<CloseableResource, () => void>();
  #revoked: SettlementAuthorityLost | null = null;

  constructor(weaker: StorageActuator, leases: readonly SettlementLease[]) {
    this.#leases = leases;
    this.actuator = revocableActuator(weaker, () => this.hold());
  }

  hold(): void {
    if (this.#revoked === null) {
      try {
        for (const lease of this.#leases) {
          lease.maintain();
          lease.assertOwned();
        }
      } catch (error: unknown) {
        this.#revoke(error);
      }
    }
    if (this.#revoked !== null) throw this.#revoked;
  }

  openDatabase<T extends CloseableResource>(open: () => T): T {
    this.hold();
    const database = open();
    const physicalClose = database.close.bind(database);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      physicalClose();
    };
    Object.defineProperty(database, 'close', { configurable: true, value: close });
    this.#resources.set(database, close);
    this.hold();
    return database;
  }

  transferDatabase<T extends CloseableResource>(database: T): T {
    this.hold();
    if (!this.#resources.delete(database)) this.#revoke(new Error('Settlement authority does not own the database.'));
    this.hold();
    return database;
  }

  #revoke(cause: unknown): void {
    if (this.#revoked !== null) return;
    this.#revoked = new SettlementAuthorityLost(cause);
    const resources = [...this.#resources.values()];
    this.#resources.clear();
    for (const close of resources) {
      try {
        close();
      } catch {
        // Revocation is permanent even when a resource reports a close failure.
      }
    }
  }
}

export function createSettlementAuthority(
  weaker: StorageActuator,
  leases: readonly SettlementLease[],
): SettlementAuthority {
  return new RevokingSettlementAuthority(weaker, leases);
}
