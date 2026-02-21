# Plugin & Extension Domain Guide

## VSCode Extension

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| extension-lifecycle | 1 | opus | Activation events, deactivation cleanup, disposable management |
| api-compatibility | 2 | sonnet | VSCode API version constraints, deprecation tracking |
| ux-guardian | 2 | sonnet | Command palette UX, status bar, webview patterns |

### Mandatory Concerns
- **Lifecycle**: activate/deactivate pairing, Disposable pattern, context subscriptions
- **API surface**: Engine version compatibility, proposed API usage, deprecation warnings
- **Performance**: Activation events (avoid `*`), lazy loading, bundle size

### Validation Checklist
#### BLOCKING
- [ ] All disposables pushed to context.subscriptions
- [ ] Activation events are specific (not `*`)
- [ ] Engine version in package.json matches used APIs
#### STRONG
- [ ] Extension bundled (esbuild/webpack)
- [ ] Commands registered with proper when-clauses

---

## Chrome Extension (Manifest V3)

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| security-guardian | 1 | opus | CSP compliance, permission minimization, message validation |
| service-worker-guardian | 1 | opus | SW lifecycle, alarm-based persistence, state management |
| api-compatibility | 2 | sonnet | Manifest V3 patterns, chrome.* API usage |

### Mandatory Concerns
- **Security**: Content Security Policy, minimal permissions, message origin validation
- **Service Worker**: No persistent background, use alarms for periodic tasks, storage.session for state
- **Permissions**: Request only what's needed, optional_permissions for non-critical features
- **Content scripts**: Isolated world, message passing, DOM manipulation safety

### Validation Checklist
#### BLOCKING
- [ ] CSP defined in manifest.json
- [ ] All message listeners validate sender
- [ ] Permissions are minimal (no `<all_urls>` without justification)
- [ ] Service worker handles termination gracefully
#### STRONG
- [ ] Optional permissions for non-essential features
- [ ] Content scripts don't leak into page context

---

## Obsidian Plugin

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| plugin-lifecycle | 1 | opus | onload/onunload cleanup, event registration, workspace events |
| settings-migrator | 2 | sonnet | Settings schema evolution, migration between versions |
| manifest-validator | 2 | sonnet | manifest.json correctness, version compatibility |

### Mandatory Concerns
- **Lifecycle**: All event registrations in onload(), all cleanup in onunload()
- **Settings**: Schema migration for version upgrades, default values, validation
- **Mobile**: Test on Obsidian Mobile, no Node.js-only APIs
- **Vault safety**: Never corrupt user data, atomic file operations

### Validation Checklist
#### BLOCKING
- [ ] All registerEvent/addCommand in onload()
- [ ] All cleanup in onunload() (intervals, observers, event listeners)
- [ ] Settings load/save works with missing fields (migration)
- [ ] No Node.js-only APIs (mobile compatibility)
#### STRONG
- [ ] manifest.json minAppVersion is accurate
- [ ] Settings UI validates input

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Missing onunload cleanup | Memory leak, duplicate handlers | Check for registerEvent without corresponding cleanup | Add to onunload or use this.register* helpers |
| Settings schema break | Plugin fails to load after update | Test with old settings file | Add migration logic in onload |
| Mobile incompatibility | Crash on mobile | Test with `Platform.isMobile` | Conditional features, no Node APIs |

---

## Claude Code Plugin

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| mcp-guardian | 1 | opus | MCP protocol compliance, tool schema validation, error handling |
| hook-safety | 2 | sonnet | Hook timeout safety, side effect management, matcher correctness |
| skill-quality | 2 | sonnet | SKILL.md quality, frontmatter correctness, reference resolution |

### Mandatory Concerns
- **MCP protocol**: Tool schemas must match Zod validation, error responses follow protocol
- **Hooks**: Timeouts must be reasonable, commands must handle failure gracefully
- **Skills**: Frontmatter fields correct, instructions clear and unambiguous
- **Agent definitions**: YAML frontmatter valid, model assignment appropriate

### Validation Checklist
#### BLOCKING
- [ ] MCP tools return valid JSON
- [ ] Hook scripts handle errors (don't crash the session)
- [ ] Plugin.json and marketplace.json versions match package.json
#### STRONG
- [ ] Skills have argument-hint for discoverability
- [ ] Agent descriptions include trigger and exclusion conditions

---

### Recommended Docs (Plugin/Extension)

No standalone domain docs required - plugin architecture is well-served by the universal docs.

**Architecture Sections**: Plugin projects should include these in `docs/ARCHITECTURE.md`:
- Extension point catalog (hooks, events, APIs exposed to users)
- Plugin lifecycle state machine (install → activate → run → deactivate → uninstall)
- Host API dependency map (which host APIs are used and version constraints)
