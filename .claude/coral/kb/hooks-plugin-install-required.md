# Plugin Hook Registration Requires Formal Install

## Rule
Plugin hooks.json에 새 이벤트를 추가한 뒤 cache 디렉토리에 수동으로 파일을 복사하면 기존 hook은 동작하지만 새 hook 이벤트는 등록되지 않는다. 정식으로 plugin을 배포하고 설치해야 hooks.json 변경이 완전히 반영된다.

## Why
Cache에 직접 복사한 뒤 "hook이 안 먹힌다"고 오진하면 settings.json으로 우회하거나, 코드 버그를 의심하며 시간을 낭비하게 된다.

## Pattern
```
# Wrong: cache에 수동 복사 후 테스트
cp hooks/new-hook.sh ~/.claude/plugins/cache/my-plugin/0.1.0/hooks/
cp hooks/hooks.json ~/.claude/plugins/cache/my-plugin/0.1.0/hooks/
# → 새 이벤트 등록 안 됨

# Right: 정식 배포 후 설치
npm run build
# plugin 배포 + Claude Code에서 재설치
# → hooks.json의 모든 이벤트 정상 등록
```
