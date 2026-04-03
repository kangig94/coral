#include "engine/usearch-hnsw.h"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace coral_vec {
namespace {

constexpr std::size_t kConnectivity = 16;
constexpr std::size_t kExpansionAdd = 64;
constexpr std::size_t kExpansionSearch = 64;

void write_string(std::ostream& output, const std::string& value) {
  const auto size = static_cast<std::uint64_t>(value.size());
  output.write(reinterpret_cast<const char*>(&size), sizeof(size));
  output.write(value.data(), static_cast<std::streamsize>(size));
}

std::string read_string(std::istream& input) {
  std::uint64_t size = 0;
  input.read(reinterpret_cast<char*>(&size), sizeof(size));
  std::string value(size, '\0');
  input.read(value.data(), static_cast<std::streamsize>(size));
  return value;
}

[[noreturn]] void raise_usearch_error(unum::usearch::error_t& error, const char* fallback) {
  const char* message = error.release();
  throw std::runtime_error(message == nullptr ? fallback : message);
}

} // namespace

void UsearchHnswEngine::build(const std::vector<VectorRecord>& records, std::size_t dim) {
  metadata_by_key_.clear();
  dimension_ = dim;
  index_ = {};

  if (records.empty() || dim == 0) {
    return;
  }

  unum::usearch::metric_punned_t metric(dim, unum::usearch::metric_kind_t::cos_k, unum::usearch::scalar_kind_t::f32_k);
  unum::usearch::index_dense_config_t config(kConnectivity, kExpansionAdd, kExpansionSearch);
  auto state = unum::usearch::index_dense_t::make(metric, config);
  if (!state) {
    raise_usearch_error(state.error, "Failed to initialize USearch index.");
  }

  index_ = std::move(state.index);
  index_.reserve(records.size());

  for (const auto& record : records) {
    if (record.values.size() != dim) {
      throw std::runtime_error("USearch build received a vector with mismatched dimensions.");
    }

    metadata_by_key_[record.key] = {record.chunk_id, record.entry_id};
    index_.add(record.key, record.values.data());
  }
}

std::vector<SearchResult> UsearchHnswEngine::search(const float* query, std::size_t top_k) const {
  if (query == nullptr || top_k == 0 || dimension_ == 0 || !index_) {
    return {};
  }

  auto matches = index_.search(query, top_k);
  std::vector<SearchResult> results;
  results.reserve(matches.size());

  for (std::size_t index = 0; index < matches.size(); ++index) {
    const auto key = static_cast<std::uint64_t>(matches[index].member.key);
    const auto metadata = metadata_by_key_.find(key);
    if (metadata == metadata_by_key_.end()) {
      continue;
    }

    results.push_back({
      metadata->second.chunk_id,
      metadata->second.entry_id,
      1.0f - static_cast<float>(matches[index].distance),
    });
  }

  return results;
}

void UsearchHnswEngine::save(const std::string& path) const {
  if (!index_) {
    return;
  }

  std::filesystem::path output_path(path);
  std::filesystem::create_directories(output_path.parent_path());
  index_.save(path.c_str());

  std::ofstream metadata(path + ".meta", std::ios::binary | std::ios::trunc);
  if (!metadata) {
    throw std::runtime_error("Failed to open USearch metadata sidecar for writing.");
  }

  const auto count = static_cast<std::uint64_t>(metadata_by_key_.size());
  metadata.write(reinterpret_cast<const char*>(&count), sizeof(count));
  metadata.write(reinterpret_cast<const char*>(&dimension_), sizeof(dimension_));

  for (const auto& [key, entry] : metadata_by_key_) {
    metadata.write(reinterpret_cast<const char*>(&key), sizeof(key));
    write_string(metadata, entry.chunk_id);
    write_string(metadata, entry.entry_id);
  }
}

void UsearchHnswEngine::load(const std::string& path) {
  auto state = unum::usearch::index_dense_t::make(path.c_str());
  if (!state) {
    raise_usearch_error(state.error, "Failed to load USearch index.");
  }

  index_ = std::move(state.index);
  dimension_ = index_.dimensions();
  metadata_by_key_.clear();

  std::ifstream metadata(path + ".meta", std::ios::binary);
  if (!metadata) {
    throw std::runtime_error("Failed to open USearch metadata sidecar for reading.");
  }

  std::uint64_t count = 0;
  metadata.read(reinterpret_cast<char*>(&count), sizeof(count));
  metadata.read(reinterpret_cast<char*>(&dimension_), sizeof(dimension_));

  for (std::uint64_t index = 0; index < count; ++index) {
    std::uint64_t key = 0;
    metadata.read(reinterpret_cast<char*>(&key), sizeof(key));
    metadata_by_key_[key] = {
      read_string(metadata),
      read_string(metadata),
    };
  }
}

std::string UsearchHnswEngine::name() const {
  return "usearch-hnsw";
}

} // namespace coral_vec
