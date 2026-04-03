#pragma once

#include "vector-engine.h"

namespace coral_vec {

class ExactScanEngine final : public VectorEngine {
public:
  void build(const std::vector<VectorRecord>& records, std::size_t dim) override;
  std::vector<SearchResult> search(const float* query, std::size_t top_k) const override;
  void save(const std::string& path) const override;
  void load(const std::string& path) override;
  std::string name() const override;

private:
  std::size_t dimension_ = 0;
  std::vector<VectorRecord> records_;
};

} // namespace coral_vec
