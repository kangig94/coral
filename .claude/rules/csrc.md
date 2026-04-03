---
paths:
  - "csrc/**/*"
---

# C++ Native Addon (csrc/)

## Build

- Clean build: `cmake -B build csrc/ && cmake --build build --config Release -j$(nproc)`
- Output: `build/coral-vec.node` (~44MB, DuckDB statically linked)
- Build time: ~2 min on 24-core, ~10-20 min on CI runners (2-4 core)
- Dependencies fetched via CMake FetchContent (DuckDB + USearch, pinned tags)

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
