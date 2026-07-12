# GPU Domain Guide

## CUDA / OptiX

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| context-guardian | 1 | opus | CUDA context lifecycle, push/pop pairing, multi-GPU context isolation |
| memory-warden | 1 | opus | GPU memory allocation/deallocation, RAII wrappers, leak detection |
| kernel-smith | 2 | sonnet | Kernel launch configuration, occupancy, shared memory usage |
| optix-pipeline | 2 | sonnet | OptiX pipeline setup, SBT records, module compilation (if OptiX detected) |

### Mandatory Concerns
- **Context lifecycle**: cuCtxPushCurrent/cuCtxPopCurrent pairing, RAII context guard, check isCUDAContextCurrent() in destructors
- **Memory safety**: Every cuMemAlloc has matching cuMemFree, RAII wrappers for all GPU allocations
- **Kernel correctness**: Grid/block dimensions match problem size, shared memory bounds, synchronization
- **Device/host transfer**: Minimize transfers, use pinned memory, async transfers with streams
- **Multi-GPU**: Context isolation per device, peer access configuration, NCCL for communication

### Validation Checklist
#### BLOCKING
- [ ] Every cuMemAlloc paired with cuMemFree (RAII pattern)
- [ ] Context push/pop paired in all code paths (including error paths)
- [ ] Kernel launch config validated (grid * block >= problem size)
- [ ] No host access to device memory without synchronization
#### STRONG
- [ ] cuda-memcheck / compute-sanitizer passes
- [ ] Occupancy calculator used for launch config
- [ ] Streams used for async operations
- [ ] Pinned memory for host-device transfers

### Core Patterns
```cpp
// CORRECT: RAII GPU memory
class DeviceBuffer {
    CUdeviceptr ptr_ = 0;
    size_t size_ = 0;
public:
    explicit DeviceBuffer(size_t bytes) : size_(bytes) {
        CU_CHECK(cuMemAlloc(&ptr_, bytes));
    }
    ~DeviceBuffer() {
        if (ptr_ && isCUDAContextCurrent()) {
            cuMemFree(ptr_);
        }
    }
    DeviceBuffer(DeviceBuffer&& o) noexcept : ptr_(o.ptr_), size_(o.size_) {
        o.ptr_ = 0;
    }
    DeviceBuffer(const DeviceBuffer&) = delete;
};

// WRONG: Manual GPU memory
CUdeviceptr ptr;
cuMemAlloc(&ptr, size);
// ... if exception here, GPU memory leaked
cuMemFree(ptr);
```

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| GPU memory leak | Out of memory after repeated runs | cuda-memcheck, cuMemGetInfo | RAII wrappers |
| Context not current | CUDA_ERROR_INVALID_CONTEXT | cuCtxGetCurrent check | Push context before GPU ops |
| Unsynced host access | Garbage data, race | compute-sanitizer --tool racecheck | cudaDeviceSynchronize or stream sync |
| Shared memory overflow | Kernel launch failure | occupancy API check | Calculate shared mem at launch |
| Missing error check | Silent corruption | `grep 'cu[A-Z]' \| grep -v 'CU_CHECK'` | Wrap all CUDA calls in error check macro |

---

## Vulkan / Metal

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| resource-lifecycle | 1 | opus | Resource creation/destruction ordering, synchronization object management |
| sync-guardian | 1 | opus | Semaphore/fence correctness, pipeline barriers, execution dependencies |
| pipeline-builder | 2 | sonnet | Pipeline state correctness, shader compilation, descriptor management |
| render-pass | 2 | sonnet | Render pass/subpass dependencies, attachment formats, load/store ops |

### Mandatory Concerns
- **Resource lifecycle**: Strict creation/destruction ordering, deferred destruction after GPU completion
- **Synchronization**: Pipeline barriers for layout transitions, semaphores between queues, fences for CPU-GPU sync
- **Validation layers**: Always enable in debug builds, zero validation errors before ship
- **Memory management**: Memory type selection, buffer/image aliasing, staging buffers for upload
- **Descriptor management**: Pool sizing, update frequency, bindless vs per-draw updates

### Validation Checklist
#### BLOCKING
- [ ] Validation layers enabled in debug (zero errors/warnings)
- [ ] All resources destroyed after GPU is idle (vkDeviceWaitIdle or fences)
- [ ] Pipeline barriers for all image layout transitions
- [ ] No synchronization hazards (dependencies between queue submissions)
#### STRONG
- [ ] Memory type selection considers device-local vs host-visible trade-offs
- [ ] Descriptor pools sized for worst case
- [ ] Render pass load/store ops optimized (DONT_CARE where possible)

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Missing barrier | Rendering artifacts, driver crash | Validation layers | Add pipeline barrier for layout transition |
| Destroy before GPU done | Use-after-free crash | Validation layers | Fence/wait before destroy |
| Wrong memory type | Slow or failed allocation | VMA warnings | Use VMA or check memory properties |
| Missing dependency | Race between passes | RenderDoc frame analysis | Add subpass dependency or barrier |

---

### Recommended Docs (GPU)

| Doc | Content | Priority | Condition |
|-----|---------|----------|-----------|
| `docs/kernel-guide.md` | Kernel inventory, launch configurations, shared memory usage, optimization notes per kernel | Strong | CUDA or compute shader project (not Vulkan/Metal graphics-only) |

**Architecture Sections**: GPU projects should include these in `docs/ARCHITECTURE.md`:
- Host-device data flow and transfer strategy
- Memory budget breakdown (global, shared, constant, texture)
- Multi-GPU topology and communication pattern (if applicable)
