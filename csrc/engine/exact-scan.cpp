#include "engine/exact-scan.h"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace coral_vec {
namespace {

float dot_product(const float* left, const float* right, std::size_t size) {
  float total = 0.0f;
  for (std::size_t index = 0; index < size; ++index) {
    total += left[index] * right[index];
  }
  return total;
}

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

} // namespace

void ExactScanEngine::build(const std::vector<VectorRecord>& records, std::size_t dim) {
  dimension_ = dim;
  records_ = records;
}

std::vector<SearchResult> ExactScanEngine::search(const float* query, std::size_t top_k) const {
  if (query == nullptr || top_k == 0 || dimension_ == 0 || records_.empty()) {
    return {};
  }

  std::vector<SearchResult> matches;
  matches.reserve(records_.size());

  for (const auto& record : records_) {
    if (record.values.size() != dimension_) {
      continue;
    }
    matches.push_back({
      record.chunk_id,
      record.entry_id,
      dot_product(query, record.values.data(), dimension_),
    });
  }

  const auto limit = std::min(top_k, matches.size());
  std::partial_sort(
    matches.begin(),
    matches.begin() + static_cast<std::ptrdiff_t>(limit),
    matches.end(),
    [](const SearchResult& left, const SearchResult& right) {
      return left.score > right.score;
    });
  matches.resize(limit);
  return matches;
}

void ExactScanEngine::save(const std::string& path) const {
  std::filesystem::path output_path(path);
  std::filesystem::create_directories(output_path.parent_path());

  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output) {
    throw std::runtime_error("Failed to open exact-scan snapshot for writing.");
  }

  const auto count = static_cast<std::uint64_t>(records_.size());
  const auto dim = static_cast<std::uint64_t>(dimension_);

  output.write(reinterpret_cast<const char*>(&count), sizeof(count));
  output.write(reinterpret_cast<const char*>(&dim), sizeof(dim));

  for (const auto& record : records_) {
    write_string(output, record.chunk_id);
    write_string(output, record.entry_id);
    const auto value_count = static_cast<std::uint64_t>(record.values.size());
    output.write(reinterpret_cast<const char*>(&value_count), sizeof(value_count));
    output.write(
      reinterpret_cast<const char*>(record.values.data()),
      static_cast<std::streamsize>(record.values.size() * sizeof(float)));
  }
}

void ExactScanEngine::load(const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("Failed to open exact-scan snapshot for reading.");
  }

  std::uint64_t count = 0;
  std::uint64_t dim = 0;
  input.read(reinterpret_cast<char*>(&count), sizeof(count));
  input.read(reinterpret_cast<char*>(&dim), sizeof(dim));

  records_.clear();
  records_.reserve(static_cast<std::size_t>(count));
  dimension_ = static_cast<std::size_t>(dim);

  for (std::uint64_t index = 0; index < count; ++index) {
    VectorRecord record {};
    record.key = index;
    record.chunk_id = read_string(input);
    record.entry_id = read_string(input);

    std::uint64_t value_count = 0;
    input.read(reinterpret_cast<char*>(&value_count), sizeof(value_count));
    record.values.resize(static_cast<std::size_t>(value_count));
    input.read(
      reinterpret_cast<char*>(record.values.data()),
      static_cast<std::streamsize>(record.values.size() * sizeof(float)));
    records_.push_back(std::move(record));
  }
}

std::string ExactScanEngine::name() const {
  return "exact-scan";
}

} // namespace coral_vec
