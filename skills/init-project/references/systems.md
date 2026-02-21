# Systems Domain Guide

## C/C++

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| memory-safety | 1 | opus | Buffer overflows, use-after-free, double-free, leak detection |
| concurrency-guardian | 1 | opus | Race conditions, deadlocks, lock ordering, atomic correctness |
| abi-checker | 2 | sonnet | ABI compatibility, symbol visibility, header correctness |
| build-guardian | 2 | sonnet | CMake/Makefile correctness, dependency management, compiler flags |

### Mandatory Concerns
- **Memory safety**: RAII for all resources, no raw new/delete, smart pointers, bounds checking
- **Concurrency**: Lock ordering to prevent deadlocks, TSAN for race detection, atomic operations
- **UB prevention**: No signed integer overflow, no null dereference, no uninitialized reads
- **Build system**: Consistent compiler flags, sanitizer support, dependency pinning

### Validation Checklist
#### BLOCKING
- [ ] AddressSanitizer (ASAN) passes
- [ ] ThreadSanitizer (TSAN) passes
- [ ] UndefinedBehaviorSanitizer (UBSAN) passes
- [ ] No raw new/delete (use smart pointers or RAII)
- [ ] Valgrind shows no leaks (if applicable)
#### STRONG
- [ ] All public headers compile standalone
- [ ] Compiler warnings treated as errors (-Werror)
- [ ] Static analysis passes (clang-tidy, cppcheck)

### Core Patterns
```cpp
// CORRECT: RAII resource management
class FileHandle {
    FILE* fp_;
public:
    explicit FileHandle(const char* path) : fp_(fopen(path, "r")) {
        if (!fp_) throw std::runtime_error("Failed to open file");
    }
    ~FileHandle() { if (fp_) fclose(fp_); }
    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;
};

// WRONG: Manual resource management
FILE* fp = fopen(path, "r");
// ... if exception thrown here, fp leaks
fclose(fp);
```

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Buffer overflow | Crash, security vulnerability | ASAN, Valgrind | Use std::vector, bounds checking |
| Use-after-free | Crash, data corruption | ASAN | Smart pointers, RAII |
| Data race | Intermittent corruption | TSAN | Mutex, atomic, lock-free design |
| Deadlock | Process hangs | TSAN, lock ordering analysis | Consistent lock ordering |
| Memory leak | Growing RSS | Valgrind, LSAN | RAII, smart pointers |

---

## Embedded / RTOS

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| resource-guardian | 1 | opus | Stack overflow, heap fragmentation, peripheral register safety |
| timing-guardian | 1 | opus | RTOS deadline compliance, ISR latency, priority inversion |
| hardware-interface | 2 | sonnet | Register access patterns, DMA correctness, peripheral initialization |

### Mandatory Concerns
- **Stack safety**: Static stack analysis, no dynamic allocation in ISRs, stack canaries
- **Timing**: Worst-case execution time analysis, priority assignment, no unbounded loops in ISRs
- **Resources**: No dynamic allocation (or fixed-size pools only), peripheral register volatile access
- **Power**: Sleep mode correctness, wake sources, peripheral clock management
- **Watchdog**: Watchdog timer configured and fed, timeout recovery path tested

### Validation Checklist
#### BLOCKING
- [ ] Stack size analysis passes (no overflow)
- [ ] No dynamic allocation in ISR context
- [ ] All peripheral registers accessed as volatile
- [ ] ISR execution time bounded and measured
- [ ] Watchdog configured with recovery path
#### STRONG
- [ ] Priority inversion prevention (priority inheritance mutex)
- [ ] Power consumption profiled
- [ ] All DMA transfers verified with completion callback

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Stack overflow | HardFault, data corruption | Stack painting, MPU guard | Increase stack size, reduce locals |
| Priority inversion | High-priority task blocked | Timing analysis, priority trace | Use priority inheritance mutex |
| Missing volatile | Compiler optimizes out read | Code review, optimization comparison | Mark hardware registers volatile |
| ISR too long | Missed deadlines | Timing measurement | Defer work to task context |

---

### Recommended Docs (Systems)

| Doc | Content | Priority | Condition |
|-----|---------|----------|-----------|
| `docs/build-guide.md` | Toolchain requirements, cross-compilation setup, dependency management, build variants | Strong | CMakeLists.txt or Makefile detected |

**Architecture Sections**: Systems projects should include these in `docs/ARCHITECTURE.md`:
- Memory layout and allocation strategy
- Thread/task model and synchronization design
- Hardware abstraction layer boundaries (if embedded)
