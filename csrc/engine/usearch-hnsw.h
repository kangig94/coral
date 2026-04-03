#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "vector-engine.h"

#include <usearch/index.hpp>
#include <usearch/index_dense.hpp>

namespace coral_vec {

class UsearchHnswEngine final : public VectorEngine {
public:
  void build(const std::vector<VectorRecord>& records, std::size_t dim) override;
  std::vector<SearchResult> search(const float* query, std::size_t top_k) const override;
  void save(const std::string& path) const override;
  void load(const std::string& path) override;
  std::string name() const override;

private:
  struct KeyMetadata {
    std::string chunk_id;
    std::string entry_id;
  };

  std::size_t dimension_ = 0;
  unum::usearch::index_dense_t index_;
  std::unordered_map<std::uint64_t, KeyMetadata> metadata_by_key_;
};

} // namespace coral_vec
