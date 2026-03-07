# Plugin Hook Registration — Install vs plugin-dir Mode

## Rule
`--plugin-dir ./` 개발 모드에서 hooks가 동작하려면 `plugin.json`에 `"hooks": "./hooks/hooks.json"` 필드가 명시적으로 선언되어야 한다. 선언 없이는 SessionStart 등 일부 hook만 우연히 동작하거나 전혀 동작하지 않는다. Cache 수동 복사도 새 hook 이벤트를 등록하지 않으므로 정식 설치가 필요하다.

## Why
`plugin.json`에 `"hooks"` 필드가 없으면 `--plugin-dir` 모드에서 hooks.json이 무시된다. 코드나 hook 로직을 의심하며 디버깅하다가 근본 원인을 놓친다.

## Pattern
```json
// WRONG: plugin.json에 hooks 선언 없음 → --plugin-dir 모드에서 PreToolUse 등 미등록
{
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}

// RIGHT: hooks 필드 명시
{
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
```

개발 중 hooks 로직만 빠르게 검증할 때는 `.claude/settings.local.json`에 직접 등록하는 방법도 있다:
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node ...", "timeout": 5 }] }]
  }
}
```
단, 이 파일은 gitignore되므로 최종 등록은 `plugin.json` + `hooks/hooks.json`으로 해야 한다.
