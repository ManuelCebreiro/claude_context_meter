'use strict';
// Lectura de los transcripts JSONL de Claude Code. Módulo sin dependencias de VS Code.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ── Precios (USD por millón de tokens) — equivalente API, aproximado ─────────
// [input, output, cacheWrite5m, cacheWrite1h, cacheRead]
const PRICES = [
  [/opus-5-5/, [4, 20, 5, 8, 0.2]],
  [/opus-5/, [5, 25, 6.25, 10, 0.5]],
  [/sonnet-5-5/, [2, 10, 2.5, 4, 0.1]],
  [/sonnet-5/, [2, 10, 2.5, 4, 0.2]],
  [/haiku-5-5/, [0.1, 0.5, 0.125, 0.2, 0.01]],
  [/(fable|mythos)-5/, [10, 50, 12.5, 20, 0.25]],
  [/opus/, [5, 25, 6.25, 10, 0.5]],
  [/sonnet/, [3, 15, 3.75, 6, 0.3]],
  [/haiku/, [1, 5, 1.25, 2, 0.1]],
];
const DEFAULT_PRICE = [3, 15, 3.75, 6, 0.3];

function priceFor(model, overrides) {
  const m = (model || '').toLowerCase();
  if (overrides) {
    for (const k of Object.keys(overrides)) if (m.includes(k.toLowerCase())) return overrides[k];
  }
  for (const [re, p] of PRICES) if (re.test(m)) return p;
  return DEFAULT_PRICE;
}

function callCost(model, u, overrides) {
  let p = priceFor(model, overrides);
  const ctx = u.input + u.cw5m + u.cw1h + u.cacheRead;
  // Haiku 5.5: tarifa x5 para prompts de más de 100k tokens
  if (/haiku-5-5/.test((model || '').toLowerCase()) && ctx > 100000) p = p.map(x => x * 5);
  return (u.input * p[0] + u.output * p[1] + u.cw5m * p[2] + u.cw1h * p[3] + u.cacheRead * p[4]) / 1e6;
}

// Ventana de contexto según la documentación de Claude Code (model-config):
// - 1M por defecto: Fable 5/5.1+, Mythos 5+, Sonnet 5 y posteriores, Haiku 5.5, Opus 4.7 y posteriores.
// - Opus 4.6 y Sonnet 4.6: 1M solo con la variante [1m]; si no, 200K.
// - Resto: 200K.
// - CLAUDE_CODE_DISABLE_1M_CONTEXT=1 lo deja todo en 200K.
function nativeOneMillion(m) {
  return /(fable|mythos)-\d/.test(m)
    || /sonnet-([5-9]|\d{2,})(\b|-|$)/.test(m)
    || /haiku-([5-9]|\d{2,})-([5-9])/.test(m) || /haiku-([6-9]|\d{2,})(\b|-|$)/.test(m)
    || /opus-4-([7-9])(\b|-|$)/.test(m) || /opus-([5-9]|\d{2,})(\b|-|$)/.test(m);
}

function contextWindowFor(model, setting, env) {
  if (setting && setting > 0) return { size: setting, reason: 'ajuste manual' };
  env = env || {};
  if (env.disable1m) return { size: 200_000, reason: 'CLAUDE_CODE_DISABLE_1M_CONTEXT=1 en tu configuración' };
  const m = (model || '').toLowerCase();
  if (m.includes('[1m]')) return { size: 1_000_000, reason: 'variante [1m]' };
  if (nativeOneMillion(m)) return { size: 1_000_000, reason: 'el modelo usa 1M por defecto' };
  if (/(opus|sonnet)-4-6/.test(m)) {
    if (env.model1m) return { size: 1_000_000, reason: 'tienes un modelo [1m] configurado' };
    if (env.observedOver200k) return { size: 1_000_000, reason: 'la sesión ya superó 200K, así que usa [1m]' };
    return { size: 200_000, reason: 'Opus/Sonnet 4.6 sin [1m]' };
  }
  if (env.observedOver200k) return { size: 1_000_000, reason: 'la sesión ya superó 200K' };
  return { size: 200_000, reason: 'modelo con ventana de 200K' };
}

// ── Utilidades ───────────────────────────────────────────────────────────────
function emptyUsage() { return { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 }; }
function addUsage(a, b) { a.input += b.input; a.output += b.output; a.cw5m += b.cw5m; a.cw1h += b.cw1h; a.cacheRead += b.cacheRead; return a; }
function usageTotal(u) { return u.input + u.output + u.cw5m + u.cw1h + u.cacheRead; }
function contextOf(u) { return u.input + u.cw5m + u.cw1h + u.cacheRead; }

function readUsage(raw) {
  const cc = raw.cache_creation || {};
  const total5m = cc.ephemeral_5m_input_tokens;
  const total1h = cc.ephemeral_1h_input_tokens;
  const cw = raw.cache_creation_input_tokens || 0;
  let cw5m, cw1h;
  if (typeof total5m === 'number' || typeof total1h === 'number') { cw5m = total5m || 0; cw1h = total1h || 0; }
  else { cw5m = 0; cw1h = cw; } // Claude Code usa TTL de 1h por defecto
  return { input: raw.input_tokens || 0, output: raw.output_tokens || 0, cw5m, cw1h, cacheRead: raw.cache_read_input_tokens || 0 };
}

function promptText(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return null;
  const c = entry.message && entry.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return null;
    const t = c.find(b => b && b.type === 'text');
    if (t) text = t.text;
    else if (c.some(b => b && b.type === 'image')) text = '[imagen]';
  }
  if (!text) return null;
  text = text.trim();
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/);
    return (cmd[1].trim() + ' ' + (args ? args[1] : '')).trim();
  }
  if (text.startsWith('<local-command') || text.startsWith('Caveat:') || text.startsWith('<system-reminder>')) return null;
  if (text.startsWith('[Request interrupted')) return null;
  return text;
}

// ── Estado incremental de una sesión ────────────────────────────────────────
// Se alimenta línea a línea; así sirve para el histórico y para la sesión en vivo.
class SessionState {
  constructor(file, pricing) {
    this.file = file;
    this.pricing = pricing;
    this.sessionId = path.basename(file, '.jsonl');
    this.cwd = null;
    this.firstTs = null;
    this.lastTs = null;
    this.title = null;
    this.calls = new Map();      // message.id -> {model, usage, ts, sidechain, promptIdx}
    this.prompts = [];           // {text, ts, compactBefore}
    this.pendingCompact = false;
    this.lastModel = null;
  }

  feedLine(line) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.cwd && !this.cwd) this.cwd = e.cwd;
    if (e.sessionId && this.sessionId.length < 10) this.sessionId = e.sessionId;
    if (e.timestamp) { if (!this.firstTs) this.firstTs = e.timestamp; this.lastTs = e.timestamp; }
    if (e.type === 'summary' && e.summary && !this.title) this.title = e.summary;
    if (e.isCompactSummary || (e.type === 'system' && e.subtype === 'compact_boundary')) { this.pendingCompact = true; return; }

    const p = promptText(e);
    if (p !== null) {
      this.prompts.push({ text: p, ts: e.timestamp || null, compactBefore: this.pendingCompact });
      this.pendingCompact = false;
      return;
    }
    if (e.type === 'assistant' && e.message && e.message.usage) {
      const model = e.message.model;
      if (model === '<synthetic>') return;
      const id = e.message.id || e.requestId || e.uuid;
      const usage = readUsage(e.message.usage);
      const prev = this.calls.get(id);
      // Claude Code escribe varias líneas por respuesta con el mismo id: nos quedamos con la última
      this.calls.set(id, {
        model, usage, ts: e.timestamp || (prev && prev.ts),
        sidechain: !!e.isSidechain,
        promptIdx: prev ? prev.promptIdx : this.prompts.length - 1,
      });
      if (!e.isSidechain) this.lastModel = model;
    }
  }

  // Añade el consumo de un archivo de subagente (va aparte, en <sesion>/subagents/*.jsonl)
  feedSubagentCall(id, model, usage, ts) {
    const prev = this.calls.get(id);
    this.calls.set(id, { model, usage, ts, sidechain: true, promptIdx: prev ? prev.promptIdx : this.prompts.length - 1 });
  }

  summary(contextWindowSetting, env) {
    const totals = emptyUsage();
    const subTotals = emptyUsage();
    const byModel = {};
    let cost = 0, peak = 0, lastCtx = 0, lastCall = null, apiCalls = 0;
    const perPrompt = this.prompts.map(p => ({
      text: p.text, ts: p.ts, compactBefore: p.compactBefore,
      startCtx: null, endCtx: 0, usage: emptyUsage(), cost: 0, calls: 0, subCalls: 0,
    }));
    const ordered = [...this.calls.values()].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    // Los subagentes vienen de otro archivo: se asignan a la pregunta por hora
    const promptTimes = this.prompts.map(p => p.ts || '');
    for (const c of ordered) {
      if (c.sidechain && c.ts) {
        let idx = -1;
        for (let i = 0; i < promptTimes.length; i++) if (promptTimes[i] && promptTimes[i] <= c.ts) idx = i;
        c.promptIdx = idx;
      }
    }
    for (const c of ordered) {
      const ccost = callCost(c.model, c.usage, this.pricing);
      cost += ccost;
      apiCalls++;
      addUsage(totals, c.usage);
      const bm = byModel[c.model] || (byModel[c.model] = { usage: emptyUsage(), cost: 0, calls: 0 });
      addUsage(bm.usage, c.usage); bm.cost += ccost; bm.calls++;
      const pp = c.promptIdx >= 0 ? perPrompt[c.promptIdx] : null;
      if (pp) { addUsage(pp.usage, c.usage); pp.cost += ccost; }
      if (c.sidechain) { addUsage(subTotals, c.usage); if (pp) pp.subCalls++; continue; }
      const ctx = contextOf(c.usage);
      if (ctx > peak) peak = ctx;
      lastCtx = ctx; lastCall = c;
      if (pp) { pp.calls++; if (pp.startCtx === null) pp.startCtx = ctx; pp.endCtx = ctx; }
    }
    const model = this.lastModel || (lastCall && lastCall.model) || null;
    return {
      file: this.file,
      sessionId: this.sessionId,
      cwd: this.cwd,
      project: this.cwd ? (this.cwd.split(/[\\/]/).filter(Boolean).pop() || this.cwd) : '(desconocido)',
      title: this.title || (this.prompts[0] ? this.prompts[0].text.slice(0, 120) : '(sin preguntas)'),
      firstTs: this.firstTs, lastTs: this.lastTs,
      prompts: this.prompts.length,
      apiCalls,
      model,
      ...(() => {
        const w = contextWindowFor(model, contextWindowSetting, { ...(env || {}), observedOver200k: peak > 200_000 });
        return { contextWindow: w.size, contextWindowReason: w.reason };
      })(),
      currentContext: lastCtx, // igual que Claude Code: entrada + caché leída + caché escrita (sin salida)
      lastCallUsage: lastCall ? lastCall.usage : emptyUsage(),
      peakContext: peak,
      totals, subTotals, byModel, cost,
      totalTokens: usageTotal(totals),
      perPrompt,
    };
  }
}

// ── Lectura incremental (no pierde líneas a medio escribir) ─────────────────
class IncrementalReader {
  constructor(file, onLine) { this.file = file; this.onLine = onLine; this.offset = 0; this.rest = ''; }
  poll() {
    let fd;
    try {
      const st = fs.statSync(this.file);
      if (st.size < this.offset) { this.offset = 0; this.rest = ''; return 'reset'; }
      if (st.size === this.offset) return false;
      fd = fs.openSync(this.file, 'r');
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += n;
      const text = this.rest + buf.subarray(0, n).toString('utf8');
      const lines = text.split('\n');
      this.rest = lines.pop(); // la última puede estar incompleta
      for (const l of lines) this.onLine(l.trim());
      return true;
    } catch { return false; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
}

function subagentFiles(sessionFile) {
  const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); }
  catch { return []; }
}

function feedSubagentFile(state, file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || !e.message || !e.message.usage || e.message.model === '<synthetic>') continue;
    state.feedSubagentCall('sub:' + (e.message.id || e.uuid), e.message.model, readUsage(e.message.usage), e.timestamp);
  }
}

function parseSessionFile(file, pricing, contextWindowSetting, env) {
  const st = new SessionState(file, pricing);
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) st.feedLine(line.trim());
  for (const sf of subagentFiles(file)) feedSubagentFile(st, sf);
  return st.summary(contextWindowSetting, env);
}

// Lista todos los transcripts principales (no subagentes)
function listSessionFiles(root = PROJECTS_DIR) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(pdir, f);
      try { const s = fs.statSync(full); out.push({ file: full, size: s.size, mtime: s.mtimeMs, projectDir: d.name }); } catch {}
    }
  }
  return out;
}

// Codificación de carpeta que usa Claude Code: todo lo no alfanumérico → '-'
function encodeProjectDir(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

function normPath(p) {
  if (!p) return '';
  let n = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32' || /^[a-zA-Z]:/.test(n)) n = n.toLowerCase().replace(/\//g, '\\');
  return n;
}

function readCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try { const e = JSON.parse(line); if (e.cwd) return e.cwd; } catch {}
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return null;
}

// Sesión activa: el transcript modificado más recientemente del proyecto abierto
function findActiveSession(workspacePaths, root = PROJECTS_DIR) {
  const all = listSessionFiles(root);
  const wanted = workspacePaths.map(normPath);
  const encoded = new Set(workspacePaths.map(p => encodeProjectDir(p).toLowerCase()));
  const candidates = all
    .filter(f => encoded.has(f.projectDir.toLowerCase()) || wanted.length === 0)
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    const cwd = readCwd(c.file);
    if (!cwd || wanted.length === 0 || wanted.includes(normPath(cwd))) return c.file;
  }
  // Plan B: comprobar el cwd de los archivos más recientes de cualquier proyecto
  const recent = all.sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  for (const c of recent) {
    const cwd = readCwd(c.file);
    if (cwd && wanted.some(w => normPath(cwd) === w || normPath(cwd).startsWith(w + path.sep))) return c.file;
  }
  return null;
}

// Lee (sin modificar) la configuración de Claude Code para saber si el 1M está desactivado
// o si hay un modelo [1m] elegido. Mira variables de entorno y los settings de usuario y proyecto.
function readClaudeEnv(workspacePaths) {
  const files = [path.join(os.homedir(), '.claude', 'settings.json')];
  for (const w of workspacePaths || []) {
    files.push(path.join(w, '.claude', 'settings.json'), path.join(w, '.claude', 'settings.local.json'));
  }
  let disable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1';
  let model1m = /\[1m\]/i.test(process.env.ANTHROPIC_MODEL || '');
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const env = j.env || {};
    if (String(env.CLAUDE_CODE_DISABLE_1M_CONTEXT) === '1') disable1m = true;
    if (/\[1m\]/i.test(String(j.model || '')) || /\[1m\]/i.test(String(env.ANTHROPIC_MODEL || ''))) model1m = true;
  }
  return { disable1m, model1m };
}

module.exports = {
  readClaudeEnv,
  PROJECTS_DIR, SessionState, IncrementalReader, parseSessionFile, listSessionFiles,
  findActiveSession, subagentFiles, feedSubagentFile, contextWindowFor, callCost, usageTotal,
  contextOf, encodeProjectDir, normPath, readUsage,
};
