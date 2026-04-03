---
paths:
  - "csrc/**/*"
---

# C++ Native Addon (csrc/)

## Build

- Clean build: `cmake -B build csrc/ && cmake --build build --config Release -j$(($(nproc)/4))`
- Always use `-j$(($(nproc)/4))` — full CPU causes freezes with large headers like duckdb.hpp
- Output: `build/coral-vec.node` (DuckDB statically linked)
- Build time: ~5 sec (DuckDB prebuilt downloaded at configure, coral code only compiled)
- DuckDB: prebuilt `libduckdb_static.a` auto-downloaded from GitHub Releases at cmake configure
- USearch: header-only, vendored in `csrc/vendor/usearch/`
- Versions tracked in `csrc/vendor/VERSIONS`
- To update DuckDB: change `DUCKDB_VERSION` in CMakeLists.txt, update `vendor/duckdb/duckdb.hpp` from matching release
- To update USearch: download headers from release, replace `csrc/vendor/usearch/`, update VERSIONS

## Versioning

- `csrc/VERSION` — independent from `package.json` (e.g., `0.1.0`)
- GitHub Releases tagged as `csrc@X.Y.Z`
- CI builds only on `main` branch push or `csrc@*` tag push

## Architecture

- N-API bridge (`bridge.cpp`) is the single cross-language contract
- DuckDB embedded — same process as search engine, `float*` direct access
- VectorEngine is pluggable: `ExactScanEngine` (baseline) + `UsearchHnswEngine` (starter)
- Per-spec immutable snapshots under `~/.coral/data/kb/vec/specs/{specId}/`

## Constraints

- `import.meta.url` is unavailable in CJS bundles — never use `createRequire(import.meta.url)` at module scope in code that gets bundled by esbuild
- `build/` is gitignored — addon distributed via GitHub Releases prebuild
- `node-addon-api` is a build-time dependency only
