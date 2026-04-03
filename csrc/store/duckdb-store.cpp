#include "store/duckdb-store.h"

#include <chrono>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>

#include "duckdb.hpp"
#include "engine/exact-scan.h"
#include "engine/usearch-hnsw.h"

#ifndef CORAL_VEC_ADDON_VERSION
#define CORAL_VEC_ADDON_VERSION "0.0.0"
#endif

#ifndef CORAL_VEC_SCHEMA_VERSION
#define CORAL_VEC_SCHEMA_VERSION 1
#endif

namespace coral_vec {
namespace {

constexpr char kDefaultEngineName[] = "exact-scan";

template <typename QueryResultT>
void throw_if_query_failed(const duckdb::unique_ptr<QueryResultT>& result, const std::string& context) {
  if (!result) {
    throw std::runtime_error(context);
  }
  if (result->HasError()) {
    throw std::runtime_error(context + ": " + result->GetError());
  }
}

std::unique_ptr<VectorEngine> create_engine(const std::string& engine_name) {
  if (engine_name == "exact-scan") {
    return std::make_unique<ExactScanEngine>();
  }
  if (engine_name == "usearch-hnsw") {
    return std::make_unique<UsearchHnswEngine>();
  }
  throw std::runtime_error("Unsupported vector engine: " + engine_name);
}

} // namespace

DuckDBStore::DuckDBStore() : engine_name_(kDefaultEngineName) {}

DuckDBStore::~DuckDBStore() {
  Close();
}

void DuckDBStore::Init(const std::string& db_path) {
  Close();

  if (db_path.empty()) {
    throw std::runtime_error("dbPath must not be empty.");
  }

  const std::filesystem::path path(db_path);
  if (path.has_parent_path()) {
    std::filesystem::create_directories(path.parent_path());
  }

  db_path_ = db_path;
  database_ = std::make_unique<duckdb::DuckDB>(db_path);
  connection_ = std::make_unique<duckdb::Connection>(*database_);

  EnsureSchema();
  LoadActiveSpecFromDb();
  if (active_spec_.has_value()) {
    EnsureVectorTable();
  }
  LoadRecordsFromDb();
  RebuildCurrentEngine();
}

void DuckDBStore::Close() {
  engine_.reset();
  connection_.reset();
  database_.reset();
  active_spec_.reset();
  records_.clear();
  db_path_.clear();
  engine_name_ = kDefaultEngineName;
}

bool DuckDBStore::IsOpen() const {
  return connection_ != nullptr;
}

void DuckDBStore::UpsertChunks(const std::vector<ChunkRecord>& chunks) {
  EnsureOpen();

  if (chunks.empty()) {
    return;
  }
  if (!active_spec_.has_value()) {
    throw std::runtime_error("Active embedding spec must be set before upserting chunks.");
  }

  for (const auto& chunk : chunks) {
    if (chunk.spec_id != active_spec_->spec_id) {
      throw std::runtime_error("Chunk specId does not match the active embedding spec.");
    }
    if (static_cast<std::int64_t>(chunk.vector.size()) != active_spec_->dims) {
      throw std::runtime_error("Chunk vector dimensions do not match the active embedding spec.");
    }
  }

  EnsureVectorTable();

  throw_if_query_failed(connection_->Query("BEGIN TRANSACTION"), "Failed to start chunk upsert transaction");

  try {
    for (const auto& chunk : chunks) {
      const auto timestamp = CurrentTimestamp();
      auto chunk_result = connection_->Query(
        "INSERT INTO chunks (id, entry_id, entry_kind, chunk_index, text, content_hash, created_at, updated_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
        "ON CONFLICT (id) DO UPDATE SET "
        "entry_id = EXCLUDED.entry_id, "
        "entry_kind = EXCLUDED.entry_kind, "
        "chunk_index = EXCLUDED.chunk_index, "
        "text = EXCLUDED.text, "
        "content_hash = EXCLUDED.content_hash, "
        "updated_at = EXCLUDED.updated_at",
        chunk.id,
        chunk.entry_id,
        chunk.entry_kind,
        static_cast<std::int32_t>(chunk.chunk_index),
        chunk.text,
        chunk.content_hash,
        timestamp,
        timestamp);
      throw_if_query_failed(chunk_result, "Failed to upsert chunk metadata");

      auto vector_result = connection_->Query(
        "INSERT INTO " + QuoteIdentifier(VectorTableIdentifier()) + " (chunk_id, entry_id, vector) "
        "VALUES ($1, $2, $3) "
        "ON CONFLICT (chunk_id) DO UPDATE SET "
        "entry_id = EXCLUDED.entry_id, "
        "vector = EXCLUDED.vector",
        chunk.id,
        chunk.entry_id,
        duckdb::Value::BLOB(
          duckdb::const_data_ptr_cast(chunk.vector.data()),
          static_cast<duckdb::idx_t>(chunk.vector.size() * sizeof(float))));
      throw_if_query_failed(vector_result, "Failed to upsert chunk vector");
    }

    throw_if_query_failed(connection_->Query("COMMIT"), "Failed to commit chunk upsert transaction");
  } catch (...) {
    connection_->Query("ROLLBACK");
    throw;
  }

  LoadRecordsFromDb();
  RebuildCurrentEngine();
}

void DuckDBStore::RemoveByEntryId(const std::string& entry_id) {
  EnsureOpen();

  if (!active_spec_.has_value()) {
    return;
  }

  EnsureVectorTable();
  throw_if_query_failed(connection_->Query("BEGIN TRANSACTION"), "Failed to start delete transaction");

  try {
    auto vector_result = connection_->Query(
      "DELETE FROM " + QuoteIdentifier(VectorTableIdentifier()) + " WHERE entry_id = $1",
      entry_id);
    throw_if_query_failed(vector_result, "Failed to delete chunk vectors");

    auto chunk_result = connection_->Query("DELETE FROM chunks WHERE entry_id = $1", entry_id);
    throw_if_query_failed(chunk_result, "Failed to delete chunk metadata");

    throw_if_query_failed(connection_->Query("COMMIT"), "Failed to commit delete transaction");
  } catch (...) {
    connection_->Query("ROLLBACK");
    throw;
  }

  LoadRecordsFromDb();
  RebuildCurrentEngine();
}

std::vector<SearchResult> DuckDBStore::SearchVector(const std::vector<float>& query, std::size_t candidate_k) const {
  if (!active_spec_.has_value() || candidate_k == 0 || records_.empty() || query.empty()) {
    return {};
  }
  if (static_cast<std::int64_t>(query.size()) != active_spec_->dims) {
    throw std::runtime_error("Query vector dimensions do not match the active embedding spec.");
  }
  if (!engine_) {
    return {};
  }
  return engine_->search(query.data(), candidate_k);
}

void DuckDBStore::BuildIndex(const std::string& engine_name) {
  EnsureOpen();
  SetEngine(engine_name.empty() ? engine_name_ : engine_name);
  RebuildCurrentEngine();
}

std::optional<EmbeddingSpec> DuckDBStore::GetActiveSpec() const {
  return active_spec_;
}

void DuckDBStore::SetActiveSpec(const EmbeddingSpec& spec) {
  EnsureOpen();

  if (spec.spec_id.empty()) {
    throw std::runtime_error("Active embedding spec must have a specId.");
  }
  if (spec.dims <= 0) {
    throw std::runtime_error("Active embedding spec must have positive dimensions.");
  }

  const auto previous_spec = active_spec_;
  if (previous_spec.has_value() && previous_spec->spec_id != spec.spec_id && !records_.empty()) {
    throw std::runtime_error("Cannot switch embedding specs on a populated snapshot.");
  }

  if (previous_spec.has_value() && previous_spec->spec_id != spec.spec_id) {
    auto drop_result = connection_->Query("DROP TABLE IF EXISTS " + QuoteIdentifier(VectorTableIdentifier()));
    throw_if_query_failed(drop_result, "Failed to drop stale vector table");
  }

  throw_if_query_failed(connection_->Query("DELETE FROM embedding_specs"), "Failed to clear embedding spec metadata");

  auto spec_result = connection_->Query(
    "INSERT INTO embedding_specs (spec_id, provider, model, dims, normalization, created_at) "
    "VALUES ($1, $2, $3, $4, $5, $6)",
    spec.spec_id,
    spec.provider,
    spec.model,
    spec.dims,
    spec.normalization,
    spec.created_at.empty() ? CurrentTimestamp() : spec.created_at);
  throw_if_query_failed(spec_result, "Failed to persist embedding spec metadata");

  active_spec_ = spec;
  if (active_spec_->created_at.empty()) {
    active_spec_->created_at = CurrentTimestamp();
  }
  EnsureVectorTable();
  LoadRecordsFromDb();
  RebuildCurrentEngine();
}

StoreStats DuckDBStore::GetStats(std::uint32_t napi_version) const {
  return {
    records_.size(),
    active_spec_.has_value() ? std::optional<std::string>(active_spec_->spec_id) : std::nullopt,
    engine_name_,
    CORAL_VEC_ADDON_VERSION,
    napi_version,
    CORAL_VEC_SCHEMA_VERSION,
  };
}

void DuckDBStore::EnsureOpen() const {
  if (!IsOpen()) {
    throw std::runtime_error("Store is not initialized. Call initStore(dbPath) first.");
  }
}

void DuckDBStore::EnsureSchema() {
  auto chunks_result = connection_->Query(
    "CREATE TABLE IF NOT EXISTS chunks ("
    "id TEXT PRIMARY KEY, "
    "entry_id TEXT NOT NULL, "
    "entry_kind TEXT NOT NULL, "
    "chunk_index INTEGER NOT NULL, "
    "text TEXT NOT NULL, "
    "content_hash TEXT NOT NULL, "
    "created_at TEXT NOT NULL, "
    "updated_at TEXT NOT NULL"
    ")");
  throw_if_query_failed(chunks_result, "Failed to create chunks table");

  auto specs_result = connection_->Query(
    "CREATE TABLE IF NOT EXISTS embedding_specs ("
    "spec_id TEXT PRIMARY KEY, "
    "provider TEXT NOT NULL, "
    "model TEXT NOT NULL, "
    "dims BIGINT NOT NULL, "
    "normalization TEXT NOT NULL, "
    "created_at TEXT NOT NULL"
    ")");
  throw_if_query_failed(specs_result, "Failed to create embedding_specs table");
}

void DuckDBStore::EnsureVectorTable() {
  if (!active_spec_.has_value()) {
    return;
  }

  auto result = connection_->Query(
    "CREATE TABLE IF NOT EXISTS " + QuoteIdentifier(VectorTableIdentifier()) + " ("
    "chunk_id TEXT PRIMARY KEY, "
    "entry_id TEXT NOT NULL, "
    "vector BLOB NOT NULL"
    ")");
  throw_if_query_failed(result, "Failed to create vector table");
}

void DuckDBStore::LoadActiveSpecFromDb() {
  active_spec_.reset();

  auto result = connection_->Query(
    "SELECT spec_id, provider, model, dims, normalization, created_at "
    "FROM embedding_specs ORDER BY created_at DESC LIMIT 1");
  throw_if_query_failed(result, "Failed to load embedding spec metadata");

  auto chunk = result->Fetch();
  if (!chunk || chunk->size() == 0) {
    return;
  }

  active_spec_ = EmbeddingSpec {
    chunk->GetValue(0, 0).GetValue<std::string>(),
    chunk->GetValue(1, 0).GetValue<std::string>(),
    chunk->GetValue(2, 0).GetValue<std::string>(),
    chunk->GetValue(3, 0).GetValue<std::int64_t>(),
    chunk->GetValue(4, 0).GetValue<std::string>(),
    chunk->GetValue(5, 0).GetValue<std::string>(),
  };
}

void DuckDBStore::LoadRecordsFromDb() {
  records_.clear();

  if (!active_spec_.has_value()) {
    return;
  }

  EnsureVectorTable();

  auto result = connection_->Query(
    "SELECT chunks.id, chunks.entry_id, vectors.vector "
    "FROM chunks "
    "JOIN " + QuoteIdentifier(VectorTableIdentifier()) + " AS vectors "
    "ON chunks.id = vectors.chunk_id "
    "ORDER BY chunks.chunk_index, chunks.id");
  throw_if_query_failed(result, "Failed to load chunk vectors from DuckDB");

  std::uint64_t key = 0;
  while (auto chunk = result->Fetch()) {
    for (duckdb::idx_t row = 0; row < chunk->size(); ++row) {
      const auto blob = chunk->GetValue(2, row).GetValueUnsafe<duckdb::string_t>();
      records_.push_back({
        key++,
        chunk->GetValue(0, row).GetValue<std::string>(),
        chunk->GetValue(1, row).GetValue<std::string>(),
        VectorFromBlob(std::string(blob.GetData(), blob.GetSize())),
      });
    }
  }
}

void DuckDBStore::RebuildCurrentEngine() {
  SetEngine(engine_name_);
  if (!active_spec_.has_value() || active_spec_->dims <= 0 || records_.empty()) {
    return;
  }

  engine_->build(records_, static_cast<std::size_t>(active_spec_->dims));
}

void DuckDBStore::SetEngine(const std::string& engine_name) {
  const auto normalized = engine_name.empty() ? std::string(kDefaultEngineName) : engine_name;
  engine_name_ = normalized;
  engine_ = create_engine(engine_name_);
}

std::string DuckDBStore::QuoteIdentifier(const std::string& identifier) const {
  std::string quoted = "\"";
  quoted.reserve(identifier.size() + 2);

  for (const char character : identifier) {
    if (character == '"') {
      quoted += "\"\"";
      continue;
    }
    quoted.push_back(character);
  }

  quoted.push_back('"');
  return quoted;
}

std::string DuckDBStore::VectorTableIdentifier() const {
  if (!active_spec_.has_value()) {
    throw std::runtime_error("Active embedding spec is not set.");
  }
  return "chunk_vectors__" + active_spec_->spec_id;
}

std::string DuckDBStore::BlobFromVector(const std::vector<float>& values) {
  return std::string(
    reinterpret_cast<const char*>(values.data()),
    values.size() * sizeof(float));
}

std::vector<float> DuckDBStore::VectorFromBlob(const std::string& blob) {
  if (blob.size() % sizeof(float) != 0) {
    throw std::runtime_error("Corrupt vector blob read from DuckDB.");
  }

  std::vector<float> values(blob.size() / sizeof(float));
  std::memcpy(values.data(), blob.data(), blob.size());
  return values;
}

std::string DuckDBStore::CurrentTimestamp() {
  const auto now = std::chrono::system_clock::now();
  const auto now_time = std::chrono::system_clock::to_time_t(now);

  std::tm utc_time {};
#if defined(_WIN32)
  gmtime_s(&utc_time, &now_time);
#else
  gmtime_r(&now_time, &utc_time);
#endif

  std::ostringstream output;
  output << std::put_time(&utc_time, "%Y-%m-%dT%H:%M:%SZ");
  return output.str();
}

} // namespace coral_vec
