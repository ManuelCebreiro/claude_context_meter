'use strict';
// Bloques de 5 horas: suma TODAS las llamadas de Claude Code de este ordenador
// (todos los proyectos, terminal y VS Code, subagentes incluidos).
// Un bloque empieza en la primera llamada (redondeada a la hora) y dura 5 h;
// la siguiente llamada fuera de ese rango abre un bloque nuevo.
// Es una estimación local: Anthropic no expone el % oficial del límite en los archivos.
const fsp = require('fs').promises;
const path = require('path');
const P = require('./parser');

const H5 = 5 * 3600 * 1000;
const LIVE_WINDOW = 2 * H5;     // archivos que el bloque en vivo relee cada 10 s
const LIVE_POLL_MS = 10_000;
const LIVE_LIST_MS = 60_000;    // cada cuánto se buscan transcripts nuevos

// Lista los .jsonl (también los de subagentes) modificados desde `minMtime`. Asíncrono.
async function listTranscripts(root = P.PROJECTS_DIR, minMtime = 0) {
  const out = [];
  const walk = async (dir, depth) => {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(ents.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) await walk(full, depth + 1); }
      else if (e.name.endsWith('.jsonl')) {
        try { const st = await fsp.stat(full); if (st.mtimeMs >= minMtime) out.push({ file: full, mtime: st.mtimeMs, size: st.size }); } catch {}
      }
    }));
  };
  await walk(root, 0);
  return out;
}

// Extrae llamadas {id, ts(ms), model, usage} de una línea
function callFromLine(line) {
  if (!line || line.charCodeAt(0) !== 123) return null;
  if (line.indexOf('"usage"') === -1) return null;
  let e; try { e = JSON.parse(line); } catch { return null; }
  if (e.type !== 'assistant' || !e.message || !e.message.usage || e.message.model === '<synthetic>') return null;
  const ts = Date.parse(e.timestamp);
  if (!ts) return null;
  return { id: e.message.id || e.requestId || e.uuid, ts, model: e.message.model, usage: P.readUsage(e.message.usage) };
}

function newBlock(start, firstTs) {
  return { start, end: start + H5, tokens: 0, freshTokens: 0, cost: 0, calls: 0, first: firstTs, last: firstTs, models: {} };
}

// Un bloque empieza con la primera llamada después de que termine el anterior y dura 5 h
// (como la ventana oficial: no se redondea a la hora en punto, solo al minuto).
// `opts` (opcional; un número equivale a { anchor }):
//  - anchor: inicio de un bloque ya conocido (p. ej. la ventana oficial actual). Las llamadas
//    anteriores se ignoran y las de [anchor, anchor + 5 h) van a ese bloque.
//  - after: final de una ventana conocida (p. ej. el último reinicio oficial). Las llamadas
//    anteriores se ignoran y la siguiente abre un bloque nuevo.
// Sin ninguno, la cadena empieza en la primera llamada que vemos y con uso continuo podría
// quedar desplazada respecto a la real.
function buildBlocks(calls, pricing, opts) {
  if (typeof opts === 'number') opts = { anchor: opts };
  const anchor = opts && opts.anchor != null ? opts.anchor : null;
  const after = opts && opts.after != null ? opts.after : null;
  const sorted = [...calls].sort((a, b) => a.ts - b.ts);
  const blocks = [];
  let cur = null, curPushed = false;
  if (anchor != null) cur = newBlock(anchor, null);
  for (const c of sorted) {
    if (anchor != null && c.ts < anchor) continue;
    if (after != null && c.ts < after) continue;
    if (!cur || c.ts >= cur.end) {
      cur = newBlock(Math.floor(c.ts / 60000) * 60000, c.ts);
      curPushed = false;
    }
    if (!curPushed) { if (cur.first == null) cur.first = c.ts; blocks.push(cur); curPushed = true; }
    const t = P.usageTotal(c.usage);
    cur.tokens += t;
    cur.freshTokens += P.freshOf(c.usage);
    cur.cost += P.callCost(c.model, c.usage, pricing);
    cur.calls++;
    cur.last = c.ts;
    cur.models[c.model] = (cur.models[c.model] || 0) + t;
  }
  return blocks;
}

// Todas las llamadas conocidas, deduplicadas por id, con un lector incremental por archivo.
// Cada archivo se lee una sola vez; después solo se leen los bytes nuevos.
class CallStore {
  constructor(root = P.PROJECTS_DIR) {
    this.root = root;
    this.readers = new Map();   // file -> IncrementalReader
    this.calls = new Map();     // id -> call
    this.models = new Map();    // para no guardar el mismo nombre de modelo miles de veces
    this.keepSince = 0;         // las llamadas anteriores se descartan
    this.version = 0;           // cambia cada vez que cambian las llamadas
  }

  _onLine(line) {
    const c = callFromLine(line);
    if (!c || c.ts < this.keepSince) return;
    const m = this.models.get(c.model);
    if (m === undefined) this.models.set(c.model, c.model); else c.model = m;
    this.calls.set(c.id, c);
    this.version++;
  }

  // Lee lo nuevo de cada archivo. Devuelve true si cambió algo.
  async pollFiles(files) {
    let changed = false;
    for (const file of files) {
      let r = this.readers.get(file);
      if (!r) { r = new P.IncrementalReader(file, (l) => this._onLine(l)); this.readers.set(file, r); }
      let res = await r.poll();
      if (res === 'reset') res = await r.poll(); // las llamadas repetidas se deduplican por id
      if (res) changed = true;
    }
    return changed;
  }

  // Lista los archivos modificados desde `sinceMs`, los lee y descarta lo anterior.
  async sync(sinceMs) {
    this.keepSince = sinceMs;
    const files = await listTranscripts(this.root, sinceMs);
    const listed = new Set(files.map(f => f.file));
    // Un lector de un archivo que ya no aparece se puede soltar: si el archivo vuelve a
    // cambiar, se relee entero y los duplicados se descartan por id.
    for (const f of this.readers.keys()) if (!listed.has(f)) this.readers.delete(f);
    let changed = await this.pollFiles(files.map(f => f.file));
    for (const [k, c] of this.calls) if (c.ts < sinceMs) { this.calls.delete(k); changed = true; }
    if (changed) this.version++;
    return changed;
  }

  callsSince(ms) {
    const out = [];
    for (const c of this.calls.values()) if (c.ts >= ms) out.push(c);
    return out;
  }
}

// Bloque actual en vivo. Comparte el almacén con el escaneo completo (scanAll), así
// que el escaneo de 90 días solo lee lo que ha cambiado desde la vez anterior.
class LiveBlocks {
  constructor(pricing, root = P.PROJECTS_DIR) {
    this.pricing = pricing;
    this.store = new CallStore(root);
    this.anchor = null;         // inicio del último bloque según el escaneo completo
    this.officialReset = null;  // hora de reinicio oficial de la ventana de 5 h (ms), si se conoce
    this.lastPoll = 0;
    this.lastList = 0;
    this.recentFiles = [];
    this._cache = null;
  }

  // Lee lo nuevo de los transcripts recientes (como mucho cada 10 s; cada 60 s busca archivos nuevos)
  async poll(now = Date.now(), force = false) {
    if (!force && now - this.lastPoll < LIVE_POLL_MS) return false;
    this.lastPoll = now;
    if (force || now - this.lastList >= LIVE_LIST_MS) {
      this.lastList = now;
      this.recentFiles = (await listTranscripts(this.store.root, now - LIVE_WINDOW)).map(f => f.file);
    }
    return this.store.pollFiles(this.recentFiles);
  }

  // Escaneo completo: lee lo que falte de los últimos `sinceMs` y devuelve todos los bloques
  async scanAll(sinceMs) {
    await this.store.sync(sinceMs);
    return buildBlocks(this.store.calls.values(), this.pricing);
  }

  current(now = Date.now()) {
    const key = `${this.store.version}|${this.anchor}|${this.officialReset}|${Math.floor(now / 60000)}`;
    if (this._cache && this._cache.key === key && this._cache.pricing === this.pricing) return this._cache.value;
    const value = this._compute(now);
    this._cache = { key, pricing: this.pricing, value };
    return value;
  }

  _compute(now) {
    // Prioridad: 1) la ventana oficial (su hora de reinicio la da Anthropic); si ya terminó,
    // la siguiente empieza con la primera llamada posterior. 2) el ancla del escaneo completo.
    // 3) sin nada, la ventana de las últimas 10 h.
    const R = this.officialReset;
    let opts, from, official = false;
    if (R != null && R > now) { opts = { anchor: R - H5 }; from = R - H5; official = true; }
    else if (R != null) { opts = { after: R }; from = R; official = true; }
    else if (this.anchor != null) { opts = { anchor: this.anchor }; from = this.anchor; }
    else { opts = undefined; from = now - LIVE_WINDOW; }
    const calls = this.store.callsSince(Math.min(from, now - 30 * 60000));
    const blocks = buildBlocks(calls, this.pricing, opts);
    const b = blocks[blocks.length - 1];
    if (!b || now >= b.end) return null;
    b.alignedToOfficial = official; // las horas vienen de la ventana oficial (no estimadas)
    // Ritmo: tokens de los últimos 30 min (total y sin caché leída)
    let recent = 0, recentFresh = 0;
    for (const c of calls) if (c.ts >= now - 30 * 60000 && c.ts >= b.start) {
      recent += P.usageTotal(c.usage);
      recentFresh += P.freshOf(c.usage);
    }
    const perMin = recent / 30, perMinFresh = recentFresh / 30;
    const minsLeft = Math.max(0, (b.end - now) / 60000);
    return {
      ...b, minsLeft,
      perMin, projected: b.tokens + perMin * minsLeft,
      perMinFresh, projectedFresh: b.freshTokens + perMinFresh * minsLeft,
    };
  }
}

// Escaneo completo de una sola vez (sin reutilizar lectores entre llamadas)
async function scanAllBlocks(pricing, sinceMs, root = P.PROJECTS_DIR) {
  const store = new CallStore(root);
  await store.sync(sinceMs || 0);
  return buildBlocks(store.calls.values(), pricing);
}

module.exports = { LiveBlocks, CallStore, scanAllBlocks, buildBlocks, callFromLine, listTranscripts, H5 };
