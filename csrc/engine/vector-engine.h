#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace coral_vec {

struct VectorRecord {
  std::uint64_t key;
  std::string chunk_id;
  std::string entry_id;
  std::vector<float> values;
};

struct SearchResult {
  std::string chunk_id;
  std::string entry_id;
  float score;
};

class VectorEngine {
public:
  virtual ~VectorEngine() = default;

  virtual void build(const std::vector<VectorRecord>& records, std::size_t dim) = 0;
  virtual std::vector<SearchResult> search(const float* query, std::size_t top_k) const = 0;
  virtual void save(const std::string& path) const = 0;
  virtual void load(const std::string& path) = 0;
  virtual std::string name() const = 0;
};

} // namespace coral_vec
