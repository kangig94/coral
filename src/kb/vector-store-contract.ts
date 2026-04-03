export const VECTOR_STORE_SCHEMA_VERSION = 1;
export const VECTOR_STORE_MIN_NAPI_VERSION = 8;

export type VectorBridgeManifest = {
  bundleHash: string;
  csrcVersion: string | null;
  schemaVersion: number | null;
  minNapiVersion: number | null;
};
