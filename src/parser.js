'use strict';
// Lectura de los transcripts JSONL de Claude Code. Módulo sin dependencias de VS Code.
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = fs.promises;
const { StringDecoder } = require('string_decoder');

// Carpeta de configuración de Claude Code: CLAUDE_CONFIG_DIR si está definida, si no ~/.claude
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
const PROJECTS_DIR = path.join(claudeConfigDir(), 'projects');

// ── Precios (USD por millón de tokens) — equivalente API, aproximado ─────────
// [input, output, cacheWrite5m, cacheWrite1h, cacheRead]
const PRICES = [
  [/opus-5-5/, [4, 20, 5, 8, 0.2]],
  [/opus-5/, [5, 25, 6.25, 10, 0.5]],
  [/sonnet-5-5/, [2, 10, 2.5, 4, 0.1]],
  [/sonnet-5/, [2, 10, 2.5, 4, 0.2]],
  [/haiku-5-5/, [0.1, 0.5, 0.125, 0.2, 0.01]],
  [/(fable|mythos)-5-2/, [8, 40, 10, 16, 0.2]],
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

// Los motivos (`reason`) van en inglés: son claves de traducción (l10n/bundle.l10n.*.json).
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
  if (setting && setting > 0) return { size: setting, reason: 'manual setting' };
  env = env || {};
  if (env.disable1m) return { size: 200_000, reason: 'CLAUDE_CODE_DISABLE_1M_CONTEXT=1 in your settings' };
  const m = (model || '').toLowerCase();
  if (m.includes('[1m]')) return { size: 1_000_000, reason: '[1m] variant' };
  if (nativeOneMillion(m)) return { size: 1_000_000, reason: 'the model uses 1M by default' };
  if (/(opus|sonnet)-4-6/.test(m)) {
    if (env.model1m) return { size: 1_000_000, reason: 'you have a [1m] model configured' };
    if (env.observedOver200k) return { size: 1_000_000, reason: 'the session already went over 200K, so it uses [1m]' };
    return { size: 200_000, reason: 'Opus/Sonnet 4.6 without [1m]' };
  }
  if (env.observedOver200k) return { size: 1_000_000, reason: 'the session already went over 200K' };
  return { size: 200_000, reason: 'model with a 200K window' };
}

// ── Utilidades ───────────────────────────────────────────────────────────────
function emptyUsage() { return { input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0 }; }
function addUsage(a, b) { a.input += b.input; a.output += b.output; a.cw5m += b.cw5m; a.cw1h += b.cw1h; a.cacheRead += b.cacheRead; return a; }
function usageTotal(u) { return u.input + u.output + u.cw5m + u.cw1h + u.cacheRead; }
function contextOf(u) { return u.input + u.cw5m + u.cw1h + u.cacheRead; }
// Tokens sin la caché leída: entrada nueva + salida + escritura en caché
function freshOf(u) { return u.input + u.output + u.cw5m + u.cw1h; }

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
  // Avisos que mete Claude Code (p. ej. al terminar una tarea en segundo plano): no los escribe el usuario
  if (entry.promptSource === 'system') return null;
  const c = entry.message && entry.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return null;
    const t = c.find(b => b && b.type === 'text');
    if (t) text = t.text;
    else if (c.some(b => b && b.type === 'image')) text = '[image]';
  }
  if (!text) return null;
  text = text.trim();
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/);
    return (cmd[1].trim() + ' ' + (args ? args[1] : '')).trim();
  }
  if (text.startsWith('<local-command') || text.startsWith('Caveat:') || text.startsWith('<system-reminder>')) return null;
  if (text.startsWith('<task-notification>')) return null;
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
    let cost = 0, peak = 0, lastCtx = 0, lastCall = null, firstCall = null, apiCalls = 0;
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
      lastCtx = ctx; lastCall = c; if (!firstCall) firstCall = c;
      if (pp) { pp.calls++; if (pp.startCtx === null) pp.startCtx = ctx; pp.endCtx = ctx; }
    }
    const model = this.lastModel || (lastCall && lastCall.model) || null;
    return {
      file: this.file,
      sessionId: this.sessionId,
      cwd: this.cwd,
      project: this.cwd ? (this.cwd.split(/[\\/]/).filter(Boolean).pop() || this.cwd) : '(unknown)',
      title: this.title || (this.prompts[0] ? this.prompts[0].text.slice(0, 120) : '(no prompts)'),
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
      firstCallUsage: firstCall ? firstCall.usage : emptyUsage(), // la parte fija (instrucciones, herramientas) suele llegar ya en caché
      peakContext: peak,
      totals, subTotals, byModel, cost,
      totalTokens: usageTotal(totals),
      perPrompt,
    };
  }
}

// ── Lectura incremental (no pierde líneas a medio escribir) ─────────────────
// Asíncrona y por trozos de 1 MB: un transcript de 50 MB ya no bloquea VS Code
// mientras se lee (cada `await` devuelve el control al resto de extensiones).
// StringDecoder guarda los bytes de un carácter UTF-8 cortado entre dos lecturas.
const CHUNK = 1 << 20;

class IncrementalReader {
  constructor(file, onLine) {
    this.file = file; this.onLine = onLine;
    this.offset = 0; this.rest = ''; this.decoder = new StringDecoder('utf8');
    this.busy = false;
  }

  // Devuelve true si leyó bytes nuevos, false si no (o si ya hay una lectura en curso)
  // y 'reset' si el archivo se ha acortado (hay que volver a leerlo desde el principio).
  async poll() {
    if (this.busy) return false;
    this.busy = true;
    let fh;
    try {
      const st = await fsp.stat(this.file);
      if (st.size < this.offset) {
        this.offset = 0; this.rest = ''; this.decoder = new StringDecoder('utf8');
        return 'reset';
      }
      if (st.size === this.offset) return false;
      fh = await fsp.open(this.file, 'r');
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - this.offset));
      let read = false;
      while (this.offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        read = true;
        const lines = (this.rest + this.decoder.write(buf.subarray(0, bytesRead))).split('\n');
        this.rest = lines.pop(); // la última puede estar incompleta
        for (const l of lines) this.onLine(l.trim());
      }
      return read;
    } catch { return false; }
    finally {
      if (fh) await fh.close().catch(() => {});
      this.busy = false;
    }
  }

  // Para lecturas de una sola vez: entrega también la última línea aunque no acabe en \n
  flush() {
    const last = (this.rest + this.decoder.end()).trim();
    this.rest = '';
    if (last) this.onLine(last);
  }
}

async function readWholeFile(file, onLine) {
  const r = new IncrementalReader(file, onLine);
  await r.poll();
  r.flush();
}

async function subagentFiles(sessionFile) {
  const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
  try { return (await fsp.readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); }
  catch { return []; }
}

// Una línea de un archivo de subagente → llamada en la sesión
function feedSubagentLine(state, line) {
  if (!line || line.charCodeAt(0) !== 123) return;
  let e; try { e = JSON.parse(line); } catch { return; }
  if (e.type !== 'assistant' || !e.message || !e.message.usage || e.message.model === '<synthetic>') return;
  state.feedSubagentCall('sub:' + (e.message.id || e.uuid), e.message.model, readUsage(e.message.usage), e.timestamp);
}

function feedSubagentFile(state, file) {
  return readWholeFile(file, (line) => feedSubagentLine(state, line));
}

async function parseSessionFile(file, pricing, contextWindowSetting, env) {
  const st = new SessionState(file, pricing);
  await readWholeFile(file, (line) => st.feedLine(line));
  for (const sf of await subagentFiles(file)) await feedSubagentFile(st, sf);
  return st.summary(contextWindowSetting, env);
}

async function jsonlFilesIn(dir, projectDir) {
  let files;
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out = await Promise.all(files.filter(f => f.endsWith('.jsonl')).map(async (f) => {
    const full = path.join(dir, f);
    try { const s = await fsp.stat(full); return { file: full, size: s.size, mtime: s.mtimeMs, projectDir }; }
    catch { return null; }
  }));
  return out.filter(Boolean);
}

// Lista todos los transcripts principales (no subagentes)
async function listSessionFiles(root = PROJECTS_DIR) {
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const lists = await Promise.all(dirs.filter(d => d.isDirectory()).map(d => jsonlFilesIn(path.join(root, d.name), d.name)));
  return lists.flat();
}

// Codificación de carpeta que usa Claude Code: todo lo no alfanumérico → '-'
function encodeProjectDir(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

function normPath(p) {
  if (!p) return '';
  let n = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32' || /^[a-zA-Z]:/.test(n)) n = n.toLowerCase().replace(/\//g, '\\');
  return n;
}

// El cwd de un transcript no cambia: se lee una vez (primeros 64 KB) y se guarda.
// Solo se guardan resultados positivos: un archivo recién creado puede no tenerlo aún.
const cwdCache = new Map();
async function readCwd(file) {
  const hit = cwdCache.get(file);
  if (hit) return hit;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const e = JSON.parse(line);
        if (e.cwd) { cwdCache.set(file, e.cwd); return e.cwd; }
      } catch {}
    }
  } catch {} finally { if (fh) await fh.close().catch(() => {}); }
  return null;
}

// Sesión activa: el transcript modificado más recientemente del proyecto abierto.
// Plan A: solo mira las carpetas de ~/.claude/projects que corresponden a las carpetas
// abiertas. Plan B (más caro, `fallback`): revisa los archivos más recientes de todos
// los proyectos, para sesiones abiertas en una subcarpeta.
async function findActiveSession(workspacePaths, root = PROJECTS_DIR, { fallback = true } = {}) {
  const wanted = workspacePaths.map(normPath);
  if (wanted.length === 0) {
    const all = (await listSessionFiles(root)).sort((a, b) => b.mtime - a.mtime);
    return all.length ? all[0].file : null;
  }
  const dirs = [...new Set(workspacePaths.map(encodeProjectDir))];
  const candidates = (await Promise.all(dirs.map(d => jsonlFilesIn(path.join(root, d), d)))).flat()
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    const cwd = await readCwd(c.file);
    if (!cwd || wanted.includes(normPath(cwd))) return c.file;
  }
  if (!fallback) return null;
  const recent = (await listSessionFiles(root)).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  for (const c of recent) {
    const cwd = await readCwd(c.file);
    if (cwd && wanted.some(w => normPath(cwd) === w || normPath(cwd).startsWith(w + path.sep))) return c.file;
  }
  return null;
}

// ── Uso oficial del plan ────────────────────────────────────────────────────
// Claude Code guarda en ~/.claude.json (o $CLAUDE_CONFIG_DIR/.claude.json; solo lectura) el último uso oficial que consultó a
// Anthropic: % de la ventana de 5 h, % semanal y sus horas de reinicio. Solo se extraen esos
// campos (nada de la cuenta). Se vuelve a leer solo si el archivo ha cambiado.
function claudeJsonPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function parseOfficialUsage(j) {
  const u = j && j.cachedUsageUtilization;
  const util = u && u.utilization;
  if (!util) return null;
  const win = (w) => w && typeof w.utilization === 'number' && w.resets_at
    ? { pct: w.utilization, resetsAt: Date.parse(w.resets_at) } : null;
  const bd = util.seven_day_breakdown;
  return {
    fetchedAt: typeof u.fetchedAtMs === 'number' ? u.fetchedAtMs : null,
    fiveHour: win(util.five_hour),
    sevenDay: win(util.seven_day),
    weeklyBreakdown: bd && Array.isArray(bd.rows)
      ? bd.rows.filter(r => r && r.percent > 0).map(r => ({ name: String(r.display_name || r.key), percent: r.percent, percentOfLimit: r.percent_of_limit }))
      : [],
  };
}

let officialCache = { key: null, value: null };
async function readOfficialUsage(file = claudeJsonPath()) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (officialCache.key === key) return officialCache.value;
  let value = null;
  try { value = parseOfficialUsage(JSON.parse(await fsp.readFile(file, 'utf8'))); } catch {}
  officialCache = { key, value };
  return value;
}

// Lee (sin modificar) la configuración de Claude Code para saber si el 1M está desactivado
// o si hay un modelo [1m] elegido. Mira variables de entorno y los settings de usuario
// (en CLAUDE_CONFIG_DIR si está definida) y de proyecto.
async function readClaudeEnv(workspacePaths) {
  const files = [path.join(claudeConfigDir(), 'settings.json')];
  for (const w of workspacePaths || []) {
    files.push(path.join(w, '.claude', 'settings.json'), path.join(w, '.claude', 'settings.local.json'));
  }
  let disable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1';
  let model1m = /\[1m\]/i.test(process.env.ANTHROPIC_MODEL || '');
  const contents = await Promise.all(files.map(f => fsp.readFile(f, 'utf8').catch(() => null)));
  for (const text of contents) {
    let j;
    try { j = JSON.parse(text); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const env = j.env || {};
    if (String(env.CLAUDE_CODE_DISABLE_1M_CONTEXT) === '1') disable1m = true;
    if (/\[1m\]/i.test(String(j.model || '')) || /\[1m\]/i.test(String(env.ANTHROPIC_MODEL || ''))) model1m = true;
  }
  return { disable1m, model1m };
}

module.exports = {
  readClaudeEnv, readOfficialUsage, parseOfficialUsage, claudeConfigDir, claudeJsonPath,
  PROJECTS_DIR, SessionState, IncrementalReader, parseSessionFile, listSessionFiles,
  findActiveSession, readCwd, subagentFiles, feedSubagentFile, feedSubagentLine, readWholeFile, contextWindowFor, callCost, usageTotal,
  contextOf, freshOf, encodeProjectDir, normPath, readUsage,
};
