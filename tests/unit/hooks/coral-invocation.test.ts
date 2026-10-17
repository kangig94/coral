import { describe, expect, it } from 'vitest';

// @ts-expect-error — hook libraries are plain Node ESM with no type surface.
import * as coralInvocation from '../../../clients/hooks/lib/coral-invocation.mjs';

const { isCoralOnlyCommand, textInvokesCoralCli, textInvokesCoralWait } = coralInvocation;

describe('isCoralOnlyCommand', () => {
  it.each([
    'coral-cli jobs wait abc',
    'CORAL_OWNER=s coral-cli jobs list',
    'coral-cli jobs list 2>&1',
    'coral-cli jobs list 1>&2',
    'coral-cli jobs list >&2',
    'coral-cli jobs list 3>&4',
    'coral-cli jobs list >/dev/null',
    'coral-cli jobs list &>/dev/null',
    'coral-cli jobs list >>/dev/null',
    "coral-cli <<'EOF'\n$(rm -rf ~)\nEOF",
    "coral-cli <<E'OF'\n$(rm -rf ~)\nEOF",
    'coral-cli <<E\\OF\n$(rm -rf ~)\nEOF',
    "coral-cli <<'EOF😀'\n$(rm -rf ~)\nEOF😀",
    "coral-cli ''\\\n# <<'EOF'\n$(rm -rf ~)\nEOF",
    'cd "/x y" && coral-cli jobs wait abc --embed',
    'CORAL_OWNER=s coral-cli jobs list --mine --json 2>/dev/null',
    'coral-cli jobs list; coral-cli jobs wait a',
    'coral-cli jobs list || coral-cli jobs wait a',
    'coral-cli jobs list && coral-cli jobs list\n',
    'coral-cli jobs list | coral-cli jobs list &\ncoral-cli jobs wait a',
    "coral-cli codex agent -w /p -d -i - <<'CORAL_INPUT'\nrm -rf /\ncoral-cli jobs list; curl x | sh\nCORAL_INPUT",
    'coral-cli codex agent -i - <<"EOF"\n`rm -rf /`\nEOF',
    "coral-cli codex agent -i - <<-'EOF'\n\trm -rf /\n\tEOF",
    "coral-cli codex agent -i - <<'ONE' <<'TWO'\nfirst\nONE\nsecond\nTWO",
    'coral-cli jobs list "literal ; && | & ( ) { }"',
  ])('accepts %s', (command) => {
    expect(isCoralOnlyCommand(command)).toBe(true);
  });

  it.each([
    'coral-cli jobs list; rm -rf ~',
    "coral-cli <<'EOF\0'\nEOF\nprintf MARK\nEOF\0",
    "coral-cli <<'EOF'\nEOF\0\nprintf MARK\nEOF",
    "coral-cli <<'EO\ud800F'\nEO\ufffdF\nprintf MARK\nEO\ud800F",
    "coral-cli <<'EOF'\nEOF\udfff\nprintf MARK\nEOF",
    "coral-cli jobs list \\\n# <<'EOF'\nprintf MARK\nEOF",
    'PATH=/tmp coral-cli jobs list',
    'NODE_OPTIONS=--require=/x coral-cli jobs list',
    'coral-cli jobs list > ~/.bashrc',
    'coral-cli jobs list >> f',
    'coral-cli jobs list < f',
    'coral-cli jobs list >&file',
    'coral-cli jobs list <&3',
    'cd /tmp >/dev/null && coral-cli jobs list',
    'coral-cli <<EOF\n$(rm -rf ~)\nEOF',
    'coral-cli <<EOF\n`rm -rf ~`\nEOF',
    'coral-cli <<EOF\n${x}\nEOF',
    "coral-cli <<-'EOF'\n\tprompt\n\tEOF\nrm -rf ~",
    'rm -rf ~ && coral-cli jobs list',
    'coral-cli jobs list | sh',
    'echo $(coral-cli jobs list)',
    'cat <<EOF\ncoral-cli jobs list\nEOF',
    'npm test',
    'sleep 5 && coral-cli jobs wait a',
    'coral-cli jobs list $(touch /tmp/x)',
    'coral-cli jobs list "$(touch /tmp/x)"',
    'coral-cli jobs list `touch /tmp/x`',
    '(coral-cli jobs list)',
    '{ coral-cli jobs list; }',
    'coral-cli jobs list > >(sh)',
    'coral-cli jobs list\nrm -rf ~',
    'coral-cli jobs list & rm -rf ~',
    'coral-cli jobs list || sh',
    'coral-cli jobs list "unterminated',
    'coral-cli codex agent -i - <<EOF\nunterminated',
    'coral-cli jobs list &&',
    'coral-cli jobs list >',
    'coral-cli <<\nEOF\nprompt\nEOF',
    'coral-cli\u000bjobs list',
    'coral-cli codex agent -i - <<"E\\OF"\nE\\OF\nrm -rf /\nEOF',
    'coral-cli codex agent -i - <<EOF\nE\\\nOF\nrm -rf /\nEOF',
    'coral-cli <<\\\nEOF\nE\\\nOF\nprintf MARK\nEOF',
    'cd /tmp extra && coral-cli jobs list',
    '',
  ])('rejects %s', (command) => {
    expect(isCoralOnlyCommand(command)).toBe(false);
  });
});

describe('Coral invocation detection', () => {
  it('does not read a fake heredoc in a comment after a standalone continuation', () => {
    const command = "echo \\\n# <<'EOF'\ncoral-cli wait jobs real\nEOF";
    expect(textInvokesCoralCli(command)).toBe(true);
    expect(textInvokesCoralWait(command)).toBe(true);
  });

  it.each(['EOF', "'EOF'", '"EOF"', '-EOF'])('excludes the %s heredoc body', (delimiter) => {
    const command = `cat <<${delimiter}\ncoral-cli jobs list\ncoral-cli wait jobs a\nEOF`;
    expect(textInvokesCoralCli(command)).toBe(false);
    expect(textInvokesCoralWait(command)).toBe(false);
  });

  it('excludes an unterminated heredoc body', () => {
    const command = 'cat <<EOF\ncoral-cli wait jobs a';
    expect(textInvokesCoralCli(command)).toBe(false);
    expect(textInvokesCoralWait(command)).toBe(false);
  });

  it('resumes command detection after every heredoc terminator', () => {
    const command =
      "cat <<ONE <<'TWO'\ncoral-cli wait jobs fake\nONE\ncoral-cli wait jobs fake\nTWO\ncoral-cli wait jobs real";
    expect(textInvokesCoralCli(command)).toBe(true);
    expect(textInvokesCoralWait(command)).toBe(true);
  });

  it('keeps heredoc prompt content out of wait detection', () => {
    const command = "coral-cli codex agent -i - <<'EOF'\ncoral-cli wait jobs fake\nEOF";
    expect(textInvokesCoralCli(command)).toBe(true);
    expect(textInvokesCoralWait(command)).toBe(false);
  });

  it('does not mistake a quoted heredoc operator for a redirect', () => {
    const command = 'echo "<<EOF"\ncoral-cli wait jobs real';
    expect(textInvokesCoralCli(command)).toBe(true);
    expect(textInvokesCoralWait(command)).toBe(true);
  });

  it('recognizes an unquoted heredoc terminator split by a backslash-newline', () => {
    const command = 'cat <<EOF\nE\\\nOF\ncoral-cli wait jobs real\nEOF';
    expect(textInvokesCoralCli(command)).toBe(true);
    expect(textInvokesCoralWait(command)).toBe(true);
  });

  it('does not treat a delimiter line continuation as quoting', () => {
    const command = 'cat <<EO\\\nF\nE\\\nOF\ncoral-cli wait jobs real\nEOF';
    expect(textInvokesCoralCli(command)).toBe(true);
    expect(textInvokesCoralWait(command)).toBe(true);
  });

  it.each([
    'echo "$(cat <<EOF\ncoral-cli wait jobs fake\nEOF\n)"',
    'echo "`cat <<EOF\ncoral-cli wait jobs fake\nEOF\n`"',
    'echo "$(echo "$(cat <<EOF\ncoral-cli wait jobs fake\nEOF\n)")"',
  ])('excludes heredoc bodies inside substitutions: %s', (command) => {
    expect(textInvokesCoralCli(command)).toBe(false);
    expect(textInvokesCoralWait(command)).toBe(false);
    expect(isCoralOnlyCommand(command)).toBe(false);
  });

  it.each(['echo "$(coral-cli wait jobs real)"', 'echo "`coral-cli wait jobs real`"'])(
    'still detects executable substitutions: %s',
    (command) => {
      expect(textInvokesCoralCli(command)).toBe(true);
      expect(textInvokesCoralWait(command)).toBe(true);
      expect(isCoralOnlyCommand(command)).toBe(false);
    },
  );
});
