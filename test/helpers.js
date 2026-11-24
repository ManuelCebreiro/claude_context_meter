'use strict';
// Utilidades para los tests: carpetas temporales y líneas de transcript sintéticas.
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-meter-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();

function userLine(text, ts, extra = {}) {
  return JSON.stringify({ type: 'user', timestamp: iso(ts), cwd: extra.cwd, message: { role: 'user', content: text }, ...extra });
}

function assistantLine(id, ts, usage, extra = {}) {
  const { model = 'claude-opus-5-5', ...rest } = extra;
  return JSON.stringify({
    type: 'assistant', timestamp: iso(ts),
    message: {
      id, model, role: 'assistant',
      usage: {
        input_tokens: usage.input || 0, output_tokens: usage.output || 0,
        cache_creation_input_tokens: usage.cw || 0, cache_read_input_tokens: usage.cacheRead || 0,
      },
    },
    ...rest,
  });
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

module.exports = { tmpDir, iso, userLine, assistantLine, writeLines };
