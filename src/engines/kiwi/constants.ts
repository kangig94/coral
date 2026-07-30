export const KIWI_INSTALL_ONLY_ID = 'kiwi';
export const KIWI_NLP_VERSION = '0.23.0';
export const KIWI_NLP_PACKAGE_URL = `https://registry.npmjs.org/kiwi-nlp/-/kiwi-nlp-${KIWI_NLP_VERSION}.tgz`;
export const KIWI_NLP_PACKAGE_INTEGRITY =
  'sha512-J/rizrydoxwD6kUnzOnWb6A3ALSDZphFmmC7XzWPb0ouXZZyhiWmgQTrI458V6KrkC21zg4G8CPew7rM0x1Cmw==';
export const KIWI_NLP_PACKAGE_SHA256 = '161965a7115f589cb64afec5d97075a057dee08022f693981b15c1b3b6f58921';
export const KIWI_NLP_PACKAGE_SIZE_BYTES = 929_082;
export const KIWI_WASM_TAR_ENTRY = 'package/dist/kiwi-wasm.wasm';
export const KIWI_WASM_FILE_NAME = 'kiwi-wasm.wasm';
export const KIWI_WASM_SHA256 = '1b78e48701468610cbb49b34105fd297dc1252774ef5c861ebf80fd6cc7d664e';
export const KIWI_WASM_SIZE_BYTES = 3_779_034;
export const KIWI_MODEL_VERSION = '0.23.0';
export const KIWI_MODEL_TYPE = 'cong-global';
const KIWI_MODEL_RELEASE_TAG = `v${KIWI_MODEL_VERSION}`;
const KIWI_MODEL_ASSET_NAME = `kiwi_model_v${KIWI_MODEL_VERSION}_base.tgz`;
export const KIWI_MODEL_URL = `https://github.com/bab2min/Kiwi/releases/download/${KIWI_MODEL_RELEASE_TAG}/${KIWI_MODEL_ASSET_NAME}`;
export const KIWI_MODEL_SHA256 = '355a006ab0bd4dec171cdca8e0b0d951e82bd5bc5993265421d8961876f20430';
export const KIWI_MODEL_ARCHIVE_SIZE_BYTES = 88_069_544;

export const KIWI_MODEL_TAR_PREFIX = 'models/cong/base/';
export const KIWI_MODEL_FILES = [
  'sj.morph',
  'default.dict',
  'dialect.dict',
  'multi.dict',
  'typo.dict',
  'combiningRule.txt',
  'cong.mdl',
  'extract.mdl',
  'nounchr.mdl',
] as const;

export type KiwiModelFileName = (typeof KIWI_MODEL_FILES)[number];
