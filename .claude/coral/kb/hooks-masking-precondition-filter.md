# False Positive Elimination — Filter on Precondition, Not on Output

## Rule
When detecting failures from command output text, don't try to improve the output pattern's precision. Instead, add a precondition check on the command itself. Exit codes can only be masked when the command contains a masking construct (`| tee`, `|| true`). If no masking construct is present, skip output inspection entirely.

## Why
Output text matching is inherently noisy — `cat error.log`, `git diff`, `grep error` all produce text containing error patterns without being failures themselves. Improving the regex just shifts false positives around. Checking the command for masking constructs eliminates the entire class of false positives because read/view commands (`cat`, `grep`, `git diff`) don't use `| tee` or `|| true`.

## Pattern
```javascript
// Wrong: check output of every Bash command
const failurePattern = /Failed to build|BUILD FAILED/m;
if (failurePattern.test(output)) { /* alert */ }
// → false positive on `cat build.log`, `git diff`, etc.

// Right: check masking precondition first, then output
const cmd = input.tool_input?.command ?? '';
if (!/\|\s*tee\b|\|\|\s*(true|:)\b/.test(cmd)) process.exit(0);
if (failurePattern.test(output)) { /* alert */ }
// → only commands that mask exit codes are inspected
```
