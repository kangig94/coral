cmake_minimum_required(VERSION 3.21)

project(coral_vec LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

set(CORAL_VEC_CONTRACT_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../src/kb/vector-store-contract.ts")
file(READ "${CORAL_VEC_CONTRACT_PATH}" CORAL_VEC_CONTRACT_SOURCE)

string(REGEX MATCH "VECTOR_STORE_SCHEMA_VERSION = ([0-9]+)" _schema_match "${CORAL_VEC_CONTRACT_SOURCE}")
if(NOT CMAKE_MATCH_1)
  message(FATAL_ERROR "Failed to read VECTOR_STORE_SCHEMA_VERSION from ${CORAL_VEC_CONTRACT_PATH}")
endif()
set(CORAL_VEC_SCHEMA_VERSION "${CMAKE_MATCH_1}")

string(REGEX MATCH "VECTOR_STORE_MIN_NAPI_VERSION = ([0-9]+)" _napi_match "${CORAL_VEC_CONTRACT_SOURCE}")
if(NOT CMAKE_MATCH_1)
  message(FATAL_ERROR "Failed to read VECTOR_STORE_MIN_NAPI_VERSION from ${CORAL_VEC_CONTRACT_PATH}")
endif()
set(CORAL_VEC_MIN_NAPI_VERSION "${CMAKE_MATCH_1}")

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/VERSION" CORAL_VEC_VERSION)
string(STRIP "${CORAL_VEC_VERSION}" CORAL_VEC_VERSION)
set(CORAL_VEC_ADDON_VERSION_DEFINE "\"${CORAL_VEC_VERSION}\"")

find_program(NODE_EXECUTABLE node REQUIRED)

execute_process(
  COMMAND "${NODE_EXECUTABLE}" -p "require('node:path').join(require('node:path').dirname(process.execPath), '..', 'include', 'node')"
  OUTPUT_VARIABLE NODE_INCLUDE_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT EXISTS "${NODE_INCLUDE_DIR}/node_api.h")
  message(FATAL_ERROR "Node headers not found at ${NODE_INCLUDE_DIR}")
endif()

set(NODE_ADDON_API_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/napi")

# --- Vendored dependencies (see vendor/VERSIONS for pinned versions) ---
set(VENDOR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor")
set(DUCKDB_VERSION "v1.5.1")
set(DUCKDB_LIB_DIR "${CMAKE_BINARY_DIR}/_duckdb")

# DuckDB prebuilt static library (downloaded at configure time)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|amd64")
  set(DUCKDB_PLATFORM "linux-amd64")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
  set(DUCKDB_PLATFORM "linux-arm64")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  set(DUCKDB_PLATFORM "osx-universal")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows" AND CMAKE_SYSTEM_PROCESSOR MATCHES "AMD64|x86_64")
  set(DUCKDB_PLATFORM "windows-amd64")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows" AND CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|aarch64")
  set(DUCKDB_PLATFORM "windows-arm64")
else()
  message(FATAL_ERROR "Unsupported platform: ${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}")
endif()

set(DUCKDB_ARCHIVE "libduckdb-${DUCKDB_PLATFORM}.zip")
set(DUCKDB_URL "https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${DUCKDB_ARCHIVE}")
set(DUCKDB_DOWNLOAD_PATH "${DUCKDB_LIB_DIR}/${DUCKDB_ARCHIVE}")
set(DUCKDB_STATIC_LIB "${DUCKDB_LIB_DIR}/libduckdb_static.a")

if(NOT EXISTS "${DUCKDB_STATIC_LIB}")
  message(STATUS "Downloading DuckDB ${DUCKDB_VERSION} prebuilt for ${DUCKDB_PLATFORM}...")
  file(DOWNLOAD "${DUCKDB_URL}" "${DUCKDB_DOWNLOAD_PATH}"
    STATUS DUCKDB_DL_STATUS
    SHOW_PROGRESS
  )
  list(GET DUCKDB_DL_STATUS 0 DUCKDB_DL_CODE)
  if(NOT DUCKDB_DL_CODE EQUAL 0)
    list(GET DUCKDB_DL_STATUS 1 DUCKDB_DL_MSG)
    message(FATAL_ERROR "Failed to download DuckDB: ${DUCKDB_DL_MSG}\nURL: ${DUCKDB_URL}")
  endif()
  execute_process(
    COMMAND ${CMAKE_COMMAND} -E tar xf "${DUCKDB_DOWNLOAD_PATH}"
    WORKING_DIRECTORY "${DUCKDB_LIB_DIR}"
    RESULT_VARIABLE DUCKDB_EXTRACT_RESULT
  )
  if(NOT DUCKDB_EXTRACT_RESULT EQUAL 0)
    message(FATAL_ERROR "Failed to extract DuckDB archive")
  endif()
endif()

add_library(duckdb_static STATIC IMPORTED)
set_target_properties(duckdb_static PROPERTIES
  IMPORTED_LOCATION "${DUCKDB_STATIC_LIB}"
  INTERFACE_INCLUDE_DIRECTORIES "${VENDOR_DIR}/duckdb"
)

# USearch (header-only, vendored)
set(USEARCH_INCLUDE_DIR "${VENDOR_DIR}/usearch")

add_library(
  coral_vec
  MODULE
  bridge.cpp
  store/duckdb-store.cpp
  engine/exact-scan.cpp
  engine/usearch-hnsw.cpp
)

target_include_directories(
  coral_vec
  PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/engine"
    "${CMAKE_CURRENT_SOURCE_DIR}/store"
    "${NODE_INCLUDE_DIR}"
    "${NODE_ADDON_API_INCLUDE_DIR}"
    "${USEARCH_INCLUDE_DIR}/include"
    "${USEARCH_INCLUDE_DIR}/fp16/include"
    "${USEARCH_INCLUDE_DIR}/simsimd/include"
    "${USEARCH_INCLUDE_DIR}/stringzilla/include"
)

target_compile_definitions(
  coral_vec
  PRIVATE
    NAPI_VERSION=${CORAL_VEC_MIN_NAPI_VERSION}
    NODE_ADDON_API_CPP_EXCEPTIONS
    CORAL_VEC_ADDON_VERSION=${CORAL_VEC_ADDON_VERSION_DEFINE}
    CORAL_VEC_SCHEMA_VERSION=${CORAL_VEC_SCHEMA_VERSION}
)

target_link_libraries(coral_vec PRIVATE duckdb_static)

set_target_properties(
  coral_vec
  PROPERTIES
    PREFIX ""
    OUTPUT_NAME "coral-vec"
    SUFFIX ".node"
)
