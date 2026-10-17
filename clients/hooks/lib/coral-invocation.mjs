const ASSIGNMENT = String.raw`[A-Za-z_]\w*=(?:[^\s'"\\;&|()]|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*")*`;
const COMMAND_LEAD = String.raw`(?:(?:${ASSIGNMENT}|time|!|\{|if|then|elif|else|while|until|do)\s+)*`;
const COMMAND_POSITION = String.raw`(?:^|[\n;&|(\x60])\s*${COMMAND_LEAD}coral-cli`;

const INVOCATION_RE = new RegExp(`${COMMAND_POSITION}(?=\\s|$|[;&|)\\x60])`);
const WAIT_INVOCATION_RE = new RegExp(`${COMMAND_POSITION}\\s+jobs\\s+wait(?=\\s|$|[;&|)\\x60])`);
const LEGACY_WAIT_INVOCATION_RE = new RegExp(`${COMMAND_POSITION}\\s+wait(?=\\s|$|[;&|)\\x60])`);

export function textInvokesCoralCli(text) {
  const { commandText, tokens } = scanCommand(text);
  return INVOCATION_RE.test(commandText) || tokensInvokeCoral(tokens);
}

export function textInvokesCoralWait(text) {
  const { commandText, tokens } = scanCommand(text);
  return (
    WAIT_INVOCATION_RE.test(commandText) ||
    LEGACY_WAIT_INVOCATION_RE.test(commandText) ||
    tokensInvokeCoral(tokens, true)
  );
}

function tokensInvokeCoral(tokens, wait = false) {
  let commandStart = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'separator') {
      commandStart = true;
    } else if (token.kind === 'redirect') {
      i++;
    } else if (commandStart && !/^[A-Za-z_]\w*=/.test(token.raw)) {
      if (isCoralCommandWord(tokens, i, wait)) return true;
      commandStart = false;
    }
  }
  return false;
}

function isCoralCommandWord(tokens, index, wait) {
  return tokens[index].raw === 'coral-cli' && (!wait || tokens[index + 1]?.raw === 'wait');
}

export function isCoralOnlyCommand(text) {
  const { tokens, safe } = scanCommand(text);
  if (!safe) return false;

  let segment = [];
  let needsCommand = false;
  let hasCommand = false;
  for (const token of tokens) {
    if (token.kind !== 'separator') {
      segment.push(token);
      continue;
    }
    if (segment.length > 0) {
      if (!isCoralSegment(segment)) return false;
      hasCommand = true;
      needsCommand = false;
      segment = [];
    } else if (token.value !== '\n') {
      return false;
    }
    if (token.value !== '\n') needsCommand = ['&&', '||', '|'].includes(token.value);
  }
  if (segment.length > 0) return isCoralSegment(segment);
  return hasCommand && !needsCommand;
}

function isCoralSegment(tokens) {
  const segment = readSegmentWords(tokens);
  if (segment === null) return false;
  const { words, redirected } = segment;
  while (words[0]?.raw.startsWith('CORAL_OWNER=')) words.shift();
  if (words[0]?.raw === 'coral-cli') return true;
  return !redirected && words[0]?.raw === 'cd' && words.length === 2;
}

function readSegmentWords(tokens) {
  const words = [];
  let redirected = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === 'redirect') {
      if (!isSafeRedirection(tokens[i].value, tokens[++i])) return null;
      redirected = true;
    } else {
      words.push(tokens[i]);
    }
  }
  return { words, redirected };
}

function isSafeRedirection(operator, target) {
  if (target?.kind !== 'word') return false;
  if (/^(?:\d+)?<<-?$/.test(operator)) return target.quoted;
  if (/^(?:\d+)?>&$/.test(operator)) return /^\d+$/.test(target.raw);
  return /^(?:\d+|&)?>>?$/.test(operator) && target.value === '/dev/null';
}

// Unknown shell syntax must never grant permission; detection may still request a rewrite.
function scanCommand(text, terminator = null) {
  const scan = {
    tokens: [], hidden: [], heredocs: [], pendingHeredoc: null,
    safe: text.isWellFormed() && !text.includes('\0'), parentheses: 0, end: 0,
  };
  while (scan.end < text.length) {
    if (text[scan.end] === terminator && scan.parentheses === 0) break;
    consumeCommandToken(text, scan, terminator);
  }
  if (scan.pendingHeredoc !== null || scan.heredocs.length > 0) scan.safe = false;
  return { ...scan, commandText: hideRanges(text, scan.hidden, scan.end) };
}

function consumeCommandToken(text, scan, terminator) {
  const i = scan.end;
  const char = text[i];
  if (/[^\S\n]/.test(char)) {
    if (char !== ' ' && char !== '\t') scan.safe = false;
    scan.end++;
  } else if (char === '#') {
    consumeComment(text, scan);
  } else if (char === '\n') {
    consumeHeredocs(text, scan);
  } else if ('(){}'.includes(char)) {
    scan.safe = false;
    if (char === '(') scan.parentheses++;
    if (char === ')') scan.parentheses--;
    scan.end++;
  } else {
    consumeShellToken(text, scan, terminator);
  }
}

function consumeComment(text, scan) {
  const newline = text.indexOf('\n', scan.end);
  const end = newline < 0 ? text.length : newline;
  scan.hidden.push([scan.end, end]);
  scan.end = end;
}

function consumeHeredocs(text, scan) {
  if (scan.pendingHeredoc !== null) scan.safe = false;
  scan.tokens.push({ kind: 'separator', value: '\n' });
  scan.end++;
  for (const heredoc of scan.heredocs) {
    const start = scan.end;
    const { end, terminated } = readHeredocBody(text, start, heredoc);
    scan.end = end;
    scan.hidden.push([start, end]);
    if (!terminated || !heredoc.quoted) scan.safe = false;
  }
  scan.heredocs.length = 0;
}

function consumeShellToken(text, scan, terminator) {
  const rest = text.slice(scan.end);
  const redirect = /^(?:(?:\d+)?(?:<<<|<<-?|>>|<>|>&|<&|>\||[<>])|&>>?)/.exec(rest);
  if (redirect) {
    const operator = redirect[0];
    scan.tokens.push({ kind: 'redirect', value: operator });
    if (scan.pendingHeredoc !== null || /<<<$/.test(operator)) scan.safe = false;
    scan.pendingHeredoc = operator.match(/<<-?$/)?.[0] ?? null;
    scan.end += operator.length;
  } else if (';&|'.includes(rest[0])) {
    const value = rest[1] === rest[0] && rest[0] !== ';' ? rest.slice(0, 2) : rest[0];
    scan.tokens.push({ kind: 'separator', value });
    scan.end += value.length;
  } else {
    consumeWord(text, scan, terminator);
  }
}

function consumeWord(text, scan, terminator) {
  const word = readShellWord(text, scan.end, terminator);
  if (word.end === scan.end) {
    scan.safe = false;
    scan.end++;
    return;
  }
  scan.end = word.end;
  if (!word.safe) scan.safe = false;
  scan.hidden.push(...word.hidden);
  scan.tokens.push({ kind: 'word', raw: word.raw, value: word.value, quoted: word.quoted });
  if (scan.pendingHeredoc !== null) {
    scan.heredocs.push({ delimiter: word.value, stripTabs: scan.pendingHeredoc === '<<-', quoted: word.quoted });
    scan.pendingHeredoc = null;
  }
}

function hideRanges(text, hidden, stop) {
  let end = 0;
  let commandText = '';
  for (const [start, stop] of hidden) {
    commandText += text.slice(end, start) + text.slice(start, stop).replace(/[^\n]/g, ' ');
    end = stop;
  }
  return commandText + text.slice(end, stop);
}

function readHeredocBody(text, start, { delimiter, stripTabs, quoted }) {
  let i = start;
  let line = '';
  while (i < text.length) {
    const newline = text.indexOf('\n', i);
    const end = newline < 0 ? text.length : newline;
    line += text.slice(i, end);
    i = newline < 0 ? text.length : newline + 1;
    if (hasHeredocContinuation(line, newline, quoted)) {
      line = line.slice(0, -1);
      continue;
    }
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) return { end: i, terminated: true };
    line = '';
  }
  return { end: i, terminated: false };
}

function hasHeredocContinuation(line, newline, quoted) {
  return !quoted && newline >= 0 && (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;
}

function readShellWord(text, start, terminator) {
  const word = { end: start, value: '', quote: null, quoted: false, safe: true, hidden: [] };
  while (word.end < text.length) {
    if (endsShellWord(text[word.end], word, terminator)) break;
    consumeWordPart(text, word);
  }
  return { ...word, raw: text.slice(start, word.end), safe: word.safe && word.quote === null };
}

function endsShellWord(current, word, terminator) {
  if (word.quote !== null) return false;
  if (current === terminator || /[\s;&|<>(){}]/.test(current)) return true;
  return current === '#' && word.value === '' && !word.quoted;
}

function consumeWordPart(text, word) {
  const current = text[word.end];
  if (word.quote !== "'" && startsSubstitution(text, word.end)) {
    consumeSubstitution(text, word);
  } else if (current === '\\' && word.quote !== "'") {
    consumeEscape(text, word);
  } else if (current === word.quote) {
    word.quote = null;
    word.end++;
  } else if (word.quote === null && ['"', "'"].includes(current)) {
    word.quote = current;
    word.quoted = true;
    word.end++;
  } else {
    if (word.quote !== "'" && current === '$') word.safe = false;
    word.value += current;
    word.end++;
  }
}

function startsSubstitution(text, offset) {
  return text[offset] === '`' || text.slice(offset, offset + 2) === '$(';
}

function consumeSubstitution(text, word) {
  word.safe = false;
  const backtick = text[word.end] === '`';
  const start = word.end + (backtick ? 1 : 2);
  const inner = scanCommand(text.slice(start), backtick ? '`' : ')');
  for (const [from, to] of inner.hidden) word.hidden.push([start + from, start + to]);
  const end = Math.min(text.length, start + inner.end + 1);
  word.value += text.slice(word.end, end);
  word.end = end;
}

function consumeEscape(text, word) {
  const next = text[word.end + 1];
  word.end = Math.min(text.length, word.end + 2);
  if (next === undefined) {
    word.safe = false;
  } else if (next !== '\n') {
    word.quoted = true;
    if (word.quote === '"' && !'$`"\\'.includes(next)) word.value += '\\';
    word.value += next;
  }
}
