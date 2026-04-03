#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "engine/vector-engine.h"

namespace duckdb {
class Connection;
class DuckDB;
}

namespace coral_vec {

struct EmbeddingSpec {
  std::string spec_id;
  std::string provider;
  std::string model;
  std::int64_t dims;
  std::string normalization;
  std::string created_at;
};

struct ChunkRecord {
  std::string id;
  std::string entry_id;
  std::string entry_kind;
  std::int32_t chunk_index;
  std::string text;
  std::string content_hash;
  std::vector<float> vector;
  std::string spec_id;
};

struct StoreStats {
  std::size_t chunk_count;
  std::optional<std::string> spec_id;
  std::string engine_name;
  std::string addon_version;
  std::uint32_t napi_version;
  std::uint32_t schema_version;
};

class DuckDBStore {
public:
  DuckDBStore();
  ~DuckDBStore();

  void Init(const std::string& db_path);
  void Close();
  bool IsOpen() const;

  void UpsertChunks(const std::vector<ChunkRecord>& chunks);
  void RemoveByEntryId(const std::string& entry_id);
  std::vector<SearchResult> SearchVector(const std::vector<float>& query, std::size_t candidate_k) const;
  void BuildIndex(const std::string& engine_name);

  std::optional<EmbeddingSpec> GetActiveSpec() const;
  void SetActiveSpec(const EmbeddingSpec& spec);
  StoreStats GetStats(std::uint32_t napi_version) const;

private:
  void EnsureOpen() const;
  void EnsureSchema();
  void EnsureVectorTable();
  void LoadActiveSpecFromDb();
  void LoadRecordsFromDb();
  void RebuildCurrentEngine();
  void SetEngine(const std::string& engine_name);
  std::string QuoteIdentifier(const std::string& identifier) const;
  std::string VectorTableIdentifier() const;

  static std::string BlobFromVector(const std::vector<float>& values);
  static std::vector<float> VectorFromBlob(const std::string& blob);
  static std::string CurrentTimestamp();

  std::string db_path_;
  std::string engine_name_;
  std::optional<EmbeddingSpec> active_spec_;
  std::vector<VectorRecord> records_;
  std::unique_ptr<duckdb::DuckDB> database_;
  std::unique_ptr<duckdb::Connection> connection_;
  std::unique_ptr<VectorEngine> engine_;
};

} // namespace coral_vec
