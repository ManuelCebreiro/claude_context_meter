'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./parser');
const B = require('./blocks');

let ctxItem, sesItem, blkItem, timer, panel, ctxRef;
let liveBlocks = null, pastBlocks = [], blockScanDone = false, lastBlockKey = '';
let live = null;          // { file, state, reader, subReaders: Map }
let lastActiveCheck = 0;
let lastSummary = null;
let history = null;       // { version, sessions: { [file]: { size, mtime, deleted?, s } } }
let scanning = false;
let claudeEnv = { disable1m: false, model1m: false };
let lastEnvRead = 0;

const cfg = () => vscode.workspace.getConfiguration('claudeMeter');

// ── Formato ──────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
const money = (x) => '$' + (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
const shortModel = (m) => (m || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '');

// ── Sesión en vivo ──────────────────────────────────────────────────────────
function workspacePaths() {
  return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
}

function attachLive(file) {
  const state = new P.SessionState(file, cfg().get('priceOverrides') || null);
  live = { file, state, reader: new P.IncrementalReader(file, l => state.feedLine(l)), subReaders: new Map() };
}

function pollSubagents() {
  for (const sf of P.subagentFiles(live.file)) {
    if (!live.subReaders.has(sf)) {
      live.subReaders.set(sf, new P.IncrementalReader(sf, (line) => {
        if (!line.startsWith('{')) return;
        let e; try { e = JSON.parse(line); } catch { return; }
        if (e.type !== 'assistant' || !e.message || !e.message.usage || e.message.model === '<synthetic>') return;
        live.state.feedSubagentCall('sub:' + (e.message.id || e.uuid), e.message.model, P.readUsage(e.message.usage), e.timestamp);
      }));
    }
  }
  let changed = false;
  for (const r of live.subReaders.values()) if (r.poll()) changed = true;
  return changed;
}

function tick() {
  const now = Date.now();
  if (now - lastEnvRead > 15000) {
    lastEnvRead = now;
    const e = P.readClaudeEnv(workspacePaths());
    if (e.disable1m !== claudeEnv.disable1m || e.model1m !== claudeEnv.model1m) { claudeEnv = e; lastSummary = null; }
  }
  try { tickBlocks(now); } catch (e) { console.error('claudeMeter blocks', e); }
  if (!live || now - lastActiveCheck > 4000) {
    lastActiveCheck = now;
    const f = P.findActiveSession(workspacePaths());
    if (f && (!live || live.file !== f)) attachLive(f);
    if (!f && live) live = null;
  }
  if (!live) { render(null); return; }
  let r = live.reader.poll();
  if (r === 'reset') { attachLive(live.file); r = live.reader.poll(); }
  const sub = pollSubagents();
  if (r || sub || !lastSummary || lastSummary.file !== live.file) {
    lastSummary = live.state.summary(cfg().get('contextWindow'), claudeEnv);
    render(lastSummary);
    if (panel) panel.webview.postMessage({ type: 'live', data: lastSummary });
  }
}

// ── Bloque de 5 horas ───────────────────────────────────────────────────────
function personalMax() {
  let max = null;
  for (const b of pastBlocks) if (b.end <= Date.now() && (!max || b.tokens > max.tokens)) max = b;
  return max;
}

const hm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
function dur(mins) { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`; }

function tickBlocks(now) {
  if (!liveBlocks) liveBlocks = new B.LiveBlocks(cfg().get('priceOverrides') || null);
  const changed = liveBlocks.poll(now);
  const b = liveBlocks.current(now);
  const key = b ? `${b.start}|${b.tokens}|${Math.floor(b.minsLeft)}` : 'none';
  if (!changed && key === lastBlockKey) return;
  lastBlockKey = key;
  renderBlock(b);
  if (panel) panel.webview.postMessage({ type: 'blocks', current: b, past: pastBlocks.slice(-30), max: personalMax() });
}

function renderBlock(b) {
  const c = cfg();
  if (!c.get('showBlock')) { blkItem.hide(); return; }
  if (!b) {
    blkItem.text = '$(clock) 5h: sin actividad';
    blkItem.tooltip = 'No hay llamadas de Claude Code en las últimas 5 horas: el próximo mensaje abrirá un bloque nuevo.';
    blkItem.backgroundColor = undefined;
    blkItem.show();
    return;
  }
  const max = personalMax();
  const ratio = max && max.tokens ? b.tokens / max.tokens : 0;
  blkItem.text = `$(clock) 5h: ${fmt(b.tokens)}${max ? ` · ${Math.round(ratio * 100)}% de tu máx.` : ''} · ${dur(b.minsLeft)}`;
  blkItem.backgroundColor = ratio >= 1 ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : ratio >= c.get('blockWarnRatio') ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Bloque de 5 h actual** (estimado): ${hm(b.start)} → ${hm(b.end)}  \n`);
  md.appendMarkdown(`Se reinicia en **${dur(b.minsLeft)}**\n\n`);
  md.appendMarkdown(`| | |\n|---|---:|\n`);
  md.appendMarkdown(`| Tokens procesados | ${fmt(b.tokens)} |\n| Llamadas a la API | ${b.calls} |\n`);
  if (c.get('showCost')) md.appendMarkdown(`| Coste equiv. API | ${money(b.cost)} |\n`);
  md.appendMarkdown(`| Ritmo (últimos 30 min) | ${fmt(b.perMin)}/min |\n| Si sigues así, al acabar | ${fmt(b.projected)} |\n`);
  if (max) md.appendMarkdown(`| Tu bloque más grande | ${fmt(max.tokens)} (${new Date(max.start).toLocaleDateString('es-ES')}) |\n`);
  md.appendMarkdown(`\n`);
  if (max && b.projected > max.tokens && ratio < 1) md.appendMarkdown(`$(warning) A este ritmo superarás tu bloque más grande antes de que se reinicie.\n\n`);
  if (!max) md.appendMarkdown(blockScanDone ? '_Aún no hay bloques anteriores para comparar._\n\n' : '_Calculando tus bloques anteriores…_\n\n');
  md.appendMarkdown(`_Suma todo Claude Code de este ordenador (todos los proyectos y subagentes). No incluye el chat de claude.ai ni otros equipos, y no es el % oficial de tu plan._\n\n`);
  md.appendMarkdown(`[$(graph) Abrir panel](command:claudeMeter.openPanel)`);
  md.isTrusted = { enabledCommands: ['claudeMeter.openPanel'] };
  blkItem.tooltip = md;
  blkItem.show();
}

async function scanBlocksBackground() {
  try {
    const since = Date.now() - 90 * 24 * 3600 * 1000;
    const all = await B.scanAllBlocks(cfg().get('priceOverrides') || null, since);
    // fusionar con los guardados (sobreviven a la limpieza de transcripts)
    const file = path.join(ctxRef.globalStorageUri.fsPath, 'blocks.json');
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const byStart = new Map(saved.map(b => [b.start, b]));
    for (const b of all) if (b.end <= Date.now()) {
      const prev = byStart.get(b.start);
      if (!prev || b.tokens >= prev.tokens) byStart.set(b.start, b);
    }
    pastBlocks = [...byStart.values()].sort((a, b) => a.start - b.start);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pastBlocks));
  } catch (e) { console.error('claudeMeter: escaneo de bloques', e); }
  blockScanDone = true;
  lastBlockKey = '';
  tickBlocks(Date.now());
}

// ── Barra de estado ─────────────────────────────────────────────────────────
function render(s) {
  const c = cfg();
  if (!s) {
    ctxItem.text = '$(layers) Claude: sin sesión';
    ctxItem.tooltip = 'No hay ninguna sesión de Claude Code para esta carpeta. Clic para ver el histórico.';
    ctxItem.backgroundColor = undefined;
    sesItem.hide();
    ctxItem.show();
    return;
  }
  const pct = s.contextWindow ? (s.currentContext / s.contextWindow) * 100 : 0;
  ctxItem.text = `$(layers) ${fmt(s.currentContext)} / ${fmt(s.contextWindow)} · ${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  ctxItem.backgroundColor = pct >= c.get('errorPercent') ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : pct >= c.get('warningPercent') ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  let t = `$(comment-discussion) ${s.prompts} · $(pulse) ${fmt(s.totalTokens)}`;
  if (c.get('showCost')) t += ` · ${money(s.cost)}`;
  sesItem.text = t;

  const lp = s.perPrompt[s.perPrompt.length - 1];
  const u = s.lastCallUsage;
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Claude Code · ${s.project}** — ${shortModel(s.model)}\n\n`);
  md.appendMarkdown(`**Contexto actual:** ${s.currentContext.toLocaleString('es-ES')} tokens (${pct.toFixed(1)}% de ${fmt(s.contextWindow)})  \n`);
  md.appendMarkdown(`Ventana ${fmt(s.contextWindow)}: ${s.contextWindowReason}  \nPico de la sesión: ${fmt(s.peakContext)}\n\n`);
  md.appendMarkdown(`| Última llamada | Tokens |\n|---|---:|\n`);
  md.appendMarkdown(`| Leídos de caché | ${fmt(u.cacheRead)} |\n| Escritos en caché | ${fmt(u.cw5m + u.cw1h)} |\n| Entrada nueva | ${fmt(u.input)} |\n| Salida | ${fmt(u.output)} |\n\n`);
  md.appendMarkdown(`**Sesión:** ${s.prompts} preguntas · ${s.apiCalls} llamadas · ${fmt(s.totalTokens)} tokens procesados`);
  if (c.get('showCost')) md.appendMarkdown(` · ${money(s.cost)} (equiv. API)`);
  md.appendMarkdown('\n\n');
  if (s.subTotals && P.usageTotal(s.subTotals) > 0) md.appendMarkdown(`Subagentes: ${fmt(P.usageTotal(s.subTotals))} tokens\n\n`);
  if (lp) {
    const txt = lp.text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]|<>]/g, ' ').slice(0, 90);
    md.appendMarkdown(`**Última pregunta:** _${txt}${lp.text.length > 90 ? '…' : ''}_  \n`);
    md.appendMarkdown(`${lp.calls} llamadas · ${fmt(P.usageTotal(lp.usage))} tokens`);
    if (c.get('showCost')) md.appendMarkdown(` · ${money(lp.cost)}`);
    md.appendMarkdown('\n\n');
  }
  md.appendMarkdown(`[$(graph) Abrir panel](command:claudeMeter.openPanel)`);
  md.isTrusted = { enabledCommands: ['claudeMeter.openPanel'] };
  ctxItem.tooltip = md;
  sesItem.tooltip = md;
  ctxItem.show(); sesItem.show();
}

// ── Histórico (archivo propio, sobrevive a la limpieza de 30 días de Claude) ─
function historyFile() { return path.join(ctxRef.globalStorageUri.fsPath, 'history.json'); }

function loadHistory() {
  if (history) return history;
  try { history = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch { history = null; }
  if (!history || history.version !== 2) history = { version: 2, sessions: {} };
  return history;
}

function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    const tmp = historyFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, historyFile());
  } catch (e) { console.error('claudeMeter: no se pudo guardar el histórico', e); }
}

function compact(s) {
  return { ...s, perPrompt: s.perPrompt.map(p => ({ ...p, text: p.text.slice(0, 400) })) };
}

async function scanHistory(progress) {
  if (scanning) return;
  scanning = true;
  try {
    const h = loadHistory();
    const files = P.listSessionFiles();
    const present = new Set(files.map(f => f.file));
    const pricing = cfg().get('priceOverrides') || null;
    const cw = cfg().get('contextWindow');
    const todo = files.filter(f => { const o = h.sessions[f.file]; return !o || o.size !== f.size || o.mtime !== f.mtime; });
    let i = 0;
    for (const f of todo) {
      try {
        const s = P.parseSessionFile(f.file, pricing, cw, claudeEnv);
        if (s.apiCalls > 0 || s.prompts > 0) h.sessions[f.file] = { size: f.size, mtime: f.mtime, s: compact(s) };
      } catch {}
      if (++i % 15 === 0) {
        if (progress) progress(i, todo.length);
        await new Promise(r => setImmediate(r));
      }
    }
    for (const k of Object.keys(h.sessions)) if (!present.has(k)) h.sessions[k].deleted = true;
    if (todo.length) saveHistory();
  } finally { scanning = false; }
}

function historyPayload() {
  const h = loadHistory();
  return Object.values(h.sessions).map(o => {
    const { perPrompt, ...rest } = o.s;
    return { ...rest, deleted: !!o.deleted };
  });
}

// ── Panel ───────────────────────────────────────────────────────────────────
function openPanel() {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel('claudeMeter', 'Claude · Tokens', vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctxRef.extensionUri, 'media')],
  });
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = panel.webview.cspSource;
  const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctxRef.extensionUri, 'media', 'panel.js'));
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctxRef.extensionUri, 'media', 'panel.css'));
  panel.webview.html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<nav><button data-tab="live" class="on">Sesión actual</button><button data-tab="hist">Histórico</button>
<span class="sp"></span><span id="status"></span><button id="refresh">↻ Actualizar</button></nav>
<main id="app"></main>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready' || m.type === 'refresh') {
      panel.webview.postMessage({ type: 'config', showCost: cfg().get('showCost') });
      if (lastSummary) panel.webview.postMessage({ type: 'live', data: lastSummary });
      lastBlockKey = '';
      tickBlocks(Date.now());
      panel.webview.postMessage({ type: 'history', data: historyPayload(), scanning: true });
      await scanHistory((i, n) => panel && panel.webview.postMessage({ type: 'progress', i, n }));
      if (panel) panel.webview.postMessage({ type: 'history', data: historyPayload(), scanning: false });
    } else if (m.type === 'detail') {
      const o = loadHistory().sessions[m.file];
      let s = o && o.s;
      if (lastSummary && lastSummary.file === m.file) s = lastSummary;
      if (panel && s) panel.webview.postMessage({ type: 'detail', data: s });
    } else if (m.type === 'openFile') {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.file));
    }
  });
}

// ── Activación ──────────────────────────────────────────────────────────────
function activate(context) {
  ctxRef = context;
  ctxItem = vscode.window.createStatusBarItem('claudeMeter.context', vscode.StatusBarAlignment.Right, 1000);
  ctxItem.name = 'Claude · contexto';
  ctxItem.command = 'claudeMeter.openPanel';
  sesItem = vscode.window.createStatusBarItem('claudeMeter.session', vscode.StatusBarAlignment.Right, 999);
  sesItem.name = 'Claude · sesión';
  sesItem.command = 'claudeMeter.openPanel';
  blkItem = vscode.window.createStatusBarItem('claudeMeter.block', vscode.StatusBarAlignment.Right, 998);
  blkItem.name = 'Claude · bloque de 5 h';
  blkItem.command = 'claudeMeter.openPanel';
  context.subscriptions.push(ctxItem, sesItem, blkItem,
    vscode.commands.registerCommand('claudeMeter.openPanel', openPanel),
    vscode.commands.registerCommand('claudeMeter.refresh', () => { live = null; lastSummary = null; lastBlockKey = ''; if (liveBlocks) liveBlocks.lastScan = 0; tick(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { live = null; lastSummary = null; tick(); }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('claudeMeter')) return;
      restartTimer();
      if (live) { lastSummary = live.state.summary(cfg().get('contextWindow'), claudeEnv); render(lastSummary); }
    }),
    { dispose: () => clearInterval(timer) },
  );
  restartTimer();
  tick();
  // Archivar el histórico en segundo plano al arrancar
  setTimeout(() => scanHistory().catch(() => {}), 8000);
  setTimeout(() => scanBlocksBackground(), 3000);
  // re-escanear el histórico de bloques cada hora (para cerrar bloques terminados)
  const hourly = setInterval(() => scanBlocksBackground(), 3600 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(hourly) });
}

function restartTimer() {
  clearInterval(timer);
  timer = setInterval(() => { try { tick(); } catch (e) { console.error('claudeMeter', e); } }, Math.max(500, cfg().get('pollMs') || 1500));
}

function deactivate() {}

module.exports = { activate, deactivate };
