// Claude Code hook: records each session's state in a small JSON file so the
// overlay can show when Claude is waiting for the user. It must stay silent on
// stdout (UserPromptSubmit output would be injected into the conversation) and
// never fail the session, so every error is swallowed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  'overlay-sessions'
);

function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${String(id).replace(/[^\w-]/g, '_')}.json`);
}

function readSession(id) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
  } catch {
    return null;
  }
}

// Write to a temp file and rename, so the overlay never reads a partial file.
function writeSession(record) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = sessionFile(record.sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

function removeSession(id) {
  try {
    fs.unlinkSync(sessionFile(id));
  } catch {}
}

// Last assistant text of the turn: newer Claude Code versions send it in the
// Stop payload; otherwise read it from the tail of the transcript (JSONL).
function lastAssistantText(input) {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
  if (!input.transcript_path) return '';
  const fd = fs.openSync(input.transcript_path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        : typeof content === 'string' ? content : '';
      if (text.trim()) return text;
    }
  } finally {
    fs.closeSync(fd);
  }
  return '';
}

function endsWithQuestion(text) {
  return /\?[\s*_`)"'»]*$/.test(text);
}

// Last meaningful line, without markdown noise, short enough for a tooltip.
function preview(text) {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.replace(/[*_`#>]/g, '').trim())
    .filter(Boolean)
    .pop() || '';
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}

function notificationType(input) {
  if (input.notification_type) return input.notification_type;
  if (/permission/i.test(input.message || '')) return 'permission_prompt';
  if (/waiting for your input/i.test(input.message || '')) return 'idle_prompt';
  return '';
}

// Returns { state, message, source } or null to leave the session as is.
function nextState(input, prev) {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { state: 'working' };
    case 'PreToolUse': {
      const q = input.tool_input?.questions?.[0]?.question;
      return { state: 'question', source: 'tool', message: preview(q) };
    }
    case 'Notification': {
      const type = notificationType(input);
      if (type === 'permission_prompt') {
        // AskUserQuestion can also raise a permission prompt; keep it a question.
        if (prev?.state === 'question' && Date.now() - prev.ts < 10000) return null;
        return { state: 'permission', source: 'tool', message: preview(input.message) };
      }
      if (type === 'elicitation_dialog') return { state: 'question', source: 'tool', message: preview(input.message) };
      return null; // idle_prompt and others: Stop already flagged the session
    }
    case 'Stop': {
      const text = lastAssistantText(input);
      return { state: endsWithQuestion(text.trim()) ? 'question' : 'done', source: 'stop', message: preview(text) };
    }
  }
  return null;
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (!input.session_id) return;
  if (input.hook_event_name === 'SessionEnd') return removeSession(input.session_id);
  const prev = readSession(input.session_id);
  const next = nextState(input, prev);
  if (!next) return;
  writeSession({
    sessionId: input.session_id,
    cwd: input.cwd || prev?.cwd || '',
    transcript: input.transcript_path || prev?.transcript || '',
    message: '',
    source: '',
    ...next,
    ts: Date.now(),
  });
}

if (require.main === module) {
  try {
    main();
  } catch {}
  process.exit(0);
}

module.exports = { SESSIONS_DIR, writeSession, removeSession };
