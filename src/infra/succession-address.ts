export const SUCCESSION_PROTOCOL_VERSION = 'v1' as const;

export const SUCCESSION_METHODS = {
  request: `coordinator.succession.${SUCCESSION_PROTOCOL_VERSION}.request`,
  prepare: `coordinator.succession.${SUCCESSION_PROTOCOL_VERSION}.prepare`,
  commit: `coordinator.succession.${SUCCESSION_PROTOCOL_VERSION}.commit`,
  abort: `coordinator.succession.${SUCCESSION_PROTOCOL_VERSION}.abort`,
  status: `coordinator.succession.${SUCCESSION_PROTOCOL_VERSION}.status`,
} as const;
