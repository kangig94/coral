cmake_minimum_required(VERSION 3.21)

project(coral_vec LANGUAGES CXX)

include(FetchContent)

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

execute_process(
  COMMAND "${NODE_EXECUTABLE}" -p "require('node:path').resolve(require('node-addon-api').include_dir)"
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/.."
  RESULT_VARIABLE NODE_ADDON_API_RESULT
  OUTPUT_VARIABLE NODE_ADDON_API_INCLUDE_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT NODE_ADDON_API_RESULT EQUAL 0)
  message(FATAL_ERROR "Failed to resolve node-addon-api. Run npm install before building the addon.")
endif()
if(NOT EXISTS "${NODE_ADDON_API_INCLUDE_DIR}/napi.h")
  message(FATAL_ERROR "node-addon-api headers not found at ${NODE_ADDON_API_INCLUDE_DIR}")
endif()

set(BUILD_UNITTESTS OFF CACHE BOOL "" FORCE)
set(BUILD_SHELL OFF CACHE BOOL "" FORCE)
set(BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(BUILD_TPCE OFF CACHE BOOL "" FORCE)
set(BUILD_PYTHON OFF CACHE BOOL "" FORCE)
set(ENABLE_SANITIZER OFF CACHE BOOL "" FORCE)
set(ENABLE_UBSAN OFF CACHE BOOL "" FORCE)
set(DISABLE_BUILTIN_EXTENSIONS ON CACHE BOOL "" FORCE)
set(DISABLE_EXTENSION_LOAD ON CACHE BOOL "" FORCE)

FetchContent_Declare(
  duckdb
  GIT_REPOSITORY https://github.com/duckdb/duckdb.git
  GIT_TAG v1.2.1
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(duckdb)

FetchContent_Declare(
  usearch
  GIT_REPOSITORY https://github.com/unum-cloud/usearch.git
  GIT_TAG v2.19.23
  GIT_SHALLOW TRUE
)
FetchContent_GetProperties(usearch)
if(NOT usearch_POPULATED)
  FetchContent_Populate(usearch)
endif()

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
    "${usearch_SOURCE_DIR}/include"
    "${usearch_SOURCE_DIR}/fp16/include"
    "${usearch_SOURCE_DIR}/simsimd/include"
    "${usearch_SOURCE_DIR}/stringzilla/include"
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
