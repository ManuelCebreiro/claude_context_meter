'use strict';
// Bloques de 5 horas: suma TODAS las llamadas de Claude Code de este ordenador
// (todos los proyectos, terminal y VS Code, subagentes incluidos).
// Un bloque empieza en la primera llamada (redondeada a la hora) y dura 5 h;
// la siguiente llamada fuera de ese rango abre un bloque nuevo.
// Es una estimación local: Anthropic no expone el % oficial del límite en los archivos.
const fs = require('fs');
const path = require('path');
const P = require('./parser');

const H5 = 5 * 3600 * 1000;

function allTranscripts(root = P.PROJECTS_DIR, minMtime = 0) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(full, depth + 1); }
      else if (e.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(full); if (st.mtimeMs >= minMtime) out.push({ file: full, mtime: st.mtimeMs, size: st.size }); } catch {}
      }
    }
  };
  walk(root, 0);
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
  return { start, end: start + H5, tokens: 0, cost: 0, calls: 0, first: firstTs, last: firstTs, models: {} };
}

// `anchor` (opcional): inicio de un bloque ya conocido por el escaneo completo.
// Las llamadas anteriores se ignoran y las que caen dentro de [anchor, anchor + 5 h)
// van a ese bloque. Sin ancla, la cadena de bloques empezaría en la primera llamada
// que vemos, y con uso continuo los bloques quedarían desplazados respecto a los reales.
function buildBlocks(calls, pricing, anchor) {
  const sorted = [...calls].sort((a, b) => a.ts - b.ts);
  const blocks = [];
  let cur = null, curPushed = false;
  if (anchor != null) cur = newBlock(anchor, null);
  for (const c of sorted) {
    if (anchor != null && c.ts < anchor) continue;
    if (!cur || c.ts >= cur.end) {
      const start = new Date(c.ts); start.setMinutes(0, 0, 0);
      cur = newBlock(start.getTime(), c.ts);
      curPushed = false;
    }
    if (!curPushed) { if (cur.first == null) cur.first = c.ts; blocks.push(cur); curPushed = true; }
    const t = P.usageTotal(c.usage);
    cur.tokens += t;
    cur.cost += P.callCost(c.model, c.usage, pricing);
    cur.calls++;
    cur.last = c.ts;
    cur.models[c.model] = (cur.models[c.model] || 0) + t;
  }
  return blocks;
}

// Mantiene en memoria las llamadas de las últimas horas, leyendo solo lo nuevo de cada archivo
class LiveBlocks {
  constructor(pricing) {
    this.pricing = pricing;
    this.readers = new Map();   // file -> IncrementalReader
    this.calls = new Map();     // id -> call
    this.lastScan = 0;
    this.anchor = null;         // inicio del último bloque según el escaneo completo
  }
  poll(now = Date.now(), force = false) {
    if (!force && now - this.lastScan < 10000) return false;
    this.lastScan = now;
    let changed = false;
    for (const f of allTranscripts(P.PROJECTS_DIR, now - H5 * 2)) {
      if (!this.readers.has(f.file)) {
        this.readers.set(f.file, new P.IncrementalReader(f.file, (line) => {
          const c = callFromLine(line);
          if (c && c.ts >= now - H5 * 2) { this.calls.set(c.id, c); }
        }));
      }
      if (this.readers.get(f.file).poll()) changed = true;
    }
    const cutoff = now - H5 * 2;
    for (const [k, c] of this.calls) if (c.ts < cutoff) { this.calls.delete(k); changed = true; }
    return changed;
  }
  current(now = Date.now()) {
    const blocks = buildBlocks(this.calls.values(), this.pricing, this.anchor);
    const b = blocks[blocks.length - 1];
    if (!b || now >= b.end) return null;
    // Ritmo: tokens de los últimos 30 min
    let recent = 0;
    for (const c of this.calls.values()) if (c.ts >= now - 30 * 60000 && c.ts >= b.start) recent += P.usageTotal(c.usage);
    const perMin = recent / 30;
    const minsLeft = Math.max(0, (b.end - now) / 60000);
    return { ...b, perMin, minsLeft, projected: b.tokens + perMin * minsLeft };
  }
}

// Escaneo completo (en segundo plano) para el histórico de bloques y tu máximo
async function scanAllBlocks(pricing, sinceMs) {
  const calls = new Map();
  const files = allTranscripts(P.PROJECTS_DIR, sinceMs || 0);
  let i = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const c = callFromLine(line.trim());
      if (c && (!sinceMs || c.ts >= sinceMs)) calls.set(c.id, c);
    }
    if (++i % 10 === 0) await new Promise(r => setImmediate(r));
  }
  return buildBlocks(calls.values(), pricing);
}

module.exports = { LiveBlocks, scanAllBlocks, buildBlocks, H5 };
