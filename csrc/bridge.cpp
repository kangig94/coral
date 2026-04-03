#include <mutex>
#include <stdexcept>
#include <vector>

#include <napi.h>

#include "store/duckdb-store.h"

namespace {

coral_vec::DuckDBStore g_store;
std::mutex g_store_mutex;

std::uint32_t current_napi_version(napi_env env) {
  std::uint32_t version = 0;
  if (napi_get_version(env, &version) != napi_ok) {
    throw std::runtime_error("Failed to read the current N-API version.");
  }
  return version;
}

std::string require_string(const Napi::Object& object, const char* key) {
  const auto value = object.Get(key);
  if (!value.IsString()) {
    throw std::runtime_error(std::string("Expected string field: ") + key);
  }
  return value.As<Napi::String>().Utf8Value();
}

std::int64_t require_int64(const Napi::Object& object, const char* key) {
  const auto value = object.Get(key);
  if (!value.IsNumber()) {
    throw std::runtime_error(std::string("Expected numeric field: ") + key);
  }
  return value.As<Napi::Number>().Int64Value();
}

std::vector<float> require_float32_vector(const Napi::Value& value) {
  if (value.IsTypedArray()) {
    auto typed_array = value.As<Napi::TypedArray>();
    if (typed_array.TypedArrayType() != napi_float32_array) {
      throw std::runtime_error("Expected Float32Array for vector data.");
    }

    auto float_array = value.As<Napi::Float32Array>();
    return {
      float_array.Data(),
      float_array.Data() + float_array.ElementLength(),
    };
  }

  if (!value.IsArray()) {
    throw std::runtime_error("Expected Float32Array or number[] for vector data.");
  }

  auto array = value.As<Napi::Array>();
  std::vector<float> result;
  result.reserve(array.Length());

  for (std::uint32_t index = 0; index < array.Length(); ++index) {
    const auto entry = array.Get(index);
    if (!entry.IsNumber()) {
      throw std::runtime_error("Vector entries must be numbers.");
    }
    result.push_back(static_cast<float>(entry.As<Napi::Number>().FloatValue()));
  }

  return result;
}

coral_vec::EmbeddingSpec parse_spec(const Napi::Object& object) {
  return {
    require_string(object, "specId"),
    require_string(object, "provider"),
    require_string(object, "model"),
    require_int64(object, "dims"),
    require_string(object, "normalization"),
    require_string(object, "createdAt"),
  };
}

coral_vec::ChunkRecord parse_chunk(const Napi::Object& object) {
  return {
    require_string(object, "id"),
    require_string(object, "entryId"),
    require_string(object, "entryKind"),
    static_cast<std::int32_t>(require_int64(object, "chunkIndex")),
    require_string(object, "text"),
    require_string(object, "contentHash"),
    require_float32_vector(object.Get("vector")),
    require_string(object, "specId"),
  };
}

Napi::Object spec_to_object(Napi::Env env, const coral_vec::EmbeddingSpec& spec) {
  auto result = Napi::Object::New(env);
  result.Set("specId", spec.spec_id);
  result.Set("provider", spec.provider);
  result.Set("model", spec.model);
  result.Set("dims", Napi::Number::New(env, static_cast<double>(spec.dims)));
  result.Set("normalization", spec.normalization);
  result.Set("createdAt", spec.created_at);
  return result;
}

Napi::Object stats_to_object(Napi::Env env, const coral_vec::StoreStats& stats) {
  auto result = Napi::Object::New(env);
  result.Set("chunkCount", Napi::Number::New(env, static_cast<double>(stats.chunk_count)));
  if (stats.spec_id.has_value()) {
    result.Set("specId", stats.spec_id.value());
  } else {
    result.Set("specId", env.Null());
  }
  result.Set("engineName", stats.engine_name);
  result.Set("addonVersion", stats.addon_version);
  result.Set("napiVersion", Napi::Number::New(env, stats.napi_version));
  result.Set("schemaVersion", Napi::Number::New(env, stats.schema_version));
  return result;
}

Napi::Value init_store(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    if (info.Length() != 1 || !info[0].IsString()) {
      throw std::runtime_error("initStore(dbPath) expects a single string argument.");
    }

    std::scoped_lock lock(g_store_mutex);
    g_store.Init(info[0].As<Napi::String>().Utf8Value());
    return env.Undefined();
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value close_store(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    std::scoped_lock lock(g_store_mutex);
    g_store.Close();
    return env.Undefined();
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value upsert_chunks(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    if (info.Length() != 1 || !info[0].IsArray()) {
      throw std::runtime_error("upsertChunks(chunks) expects a single array argument.");
    }

    auto array = info[0].As<Napi::Array>();
    std::vector<coral_vec::ChunkRecord> chunks;
    chunks.reserve(array.Length());

    for (std::uint32_t index = 0; index < array.Length(); ++index) {
      const auto value = array.Get(index);
      if (!value.IsObject()) {
        throw std::runtime_error("Chunk entries must be objects.");
      }
      chunks.push_back(parse_chunk(value.As<Napi::Object>()));
    }

    std::scoped_lock lock(g_store_mutex);
    g_store.UpsertChunks(chunks);
    return env.Undefined();
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value remove_by_entry_id(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    if (info.Length() != 1 || !info[0].IsString()) {
      throw std::runtime_error("removeByEntryId(entryId) expects a single string argument.");
    }

    std::scoped_lock lock(g_store_mutex);
    g_store.RemoveByEntryId(info[0].As<Napi::String>().Utf8Value());
    return env.Undefined();
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value search_vector(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    if (info.Length() != 2 || !info[1].IsNumber()) {
      throw std::runtime_error("searchVector(queryVec, candidateK) expects a vector and a numeric candidate count.");
    }

    const auto query = require_float32_vector(info[0]);
    const auto candidate_k = static_cast<std::size_t>(info[1].As<Napi::Number>().Int64Value());

    std::scoped_lock lock(g_store_mutex);
    const auto results = g_store.SearchVector(query, candidate_k);

    auto array = Napi::Array::New(env, results.size());
    for (std::size_t index = 0; index < results.size(); ++index) {
      auto entry = Napi::Object::New(env);
      entry.Set("chunkId", results[index].chunk_id);
      entry.Set("entryId", results[index].entry_id);
      entry.Set("score", Napi::Number::New(env, results[index].score));
      array.Set(static_cast<std::uint32_t>(index), entry);
    }

    return array;
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value build_index(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    std::string engine_name;
    if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
      if (!info[0].IsString()) {
        throw std::runtime_error("buildIndex(engineName) expects an optional string argument.");
      }
      engine_name = info[0].As<Napi::String>().Utf8Value();
    }

    std::scoped_lock lock(g_store_mutex);
    g_store.BuildIndex(engine_name);
    return env.Undefined();
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value get_active_spec(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    std::scoped_lock lock(g_store_mutex);
    const auto spec = g_store.GetActiveSpec();
    if (!spec.has_value()) {
      return env.Null();
    }
    return spec_to_object(env, spec.value());
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value set_active_spec(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    if (info.Length() != 1 || !info[0].IsObject()) {
      throw std::runtime_error("setActiveSpec(spec) expects a single object argument.");
    }

    std::scoped_lock lock(g_store_mutex);
    g_store.SetActiveSpec(parse_spec(info[0].As<Napi::Object>()));
    return env.Undefined();
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Value get_stats(const Napi::CallbackInfo& info) {
  auto env = info.Env();

  try {
    std::scoped_lock lock(g_store_mutex);
    return stats_to_object(env, g_store.GetStats(current_napi_version(env)));
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  }
}

} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("initStore", Napi::Function::New(env, init_store));
  exports.Set("closeStore", Napi::Function::New(env, close_store));
  exports.Set("upsertChunks", Napi::Function::New(env, upsert_chunks));
  exports.Set("removeByEntryId", Napi::Function::New(env, remove_by_entry_id));
  exports.Set("searchVector", Napi::Function::New(env, search_vector));
  exports.Set("buildIndex", Napi::Function::New(env, build_index));
  exports.Set("getActiveSpec", Napi::Function::New(env, get_active_spec));
  exports.Set("setActiveSpec", Napi::Function::New(env, set_active_spec));
  exports.Set("getStats", Napi::Function::New(env, get_stats));
  return exports;
}

NODE_API_MODULE(coral_vec, Init)
