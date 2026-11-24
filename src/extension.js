'use strict';
const vscode = require('vscode');
const fsp = require('fs').promises;
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
let claudeEnv = { disable1m: false, model1m: false };
let lastEnvRead = 0;

const cfg = () => vscode.workspace.getConfiguration('claudeMeter');
const pricing = () => cfg().get('priceOverrides') || null;
const panelConfig = () => {
  const c = cfg();
  return { type: 'config', showCost: c.get('showCost'), warningPercent: c.get('warningPercent'), errorPercent: c.get('errorPercent'), blockWarnRatio: c.get('blockWarnRatio') };
};

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
  const state = new P.SessionState(file, pricing());
  live = { file, state, reader: new P.IncrementalReader(file, l => state.feedLine(l)), subReaders: new Map() };
}

async function pollSubagents(L) {
  for (const sf of await P.subagentFiles(L.file)) {
    if (!L.subReaders.has(sf)) L.subReaders.set(sf, new P.IncrementalReader(sf, (line) => P.feedSubagentLine(L.state, line)));
  }
  let changed = false;
  for (const r of L.subReaders.values()) if (await r.poll()) changed = true;
  return changed;
}

// Un tick a la vez: si una lectura grande tarda más que pollMs, el siguiente se salta.
let ticking = false;
let lastFallback = 0;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { await tickOnce(); } catch (e) { console.error('claudeMeter', e); } finally { ticking = false; }
}

async function tickOnce() {
  const now = Date.now();
  if (now - lastEnvRead > 15000) {
    lastEnvRead = now;
    const e = await P.readClaudeEnv(workspacePaths());
    if (e.disable1m !== claudeEnv.disable1m || e.model1m !== claudeEnv.model1m) { claudeEnv = e; lastSummary = null; }
  }
  pollBlocks(now);
  if (!live || now - lastActiveCheck > 4000) {
    lastActiveCheck = now;
    // El plan B (revisar todos los proyectos) solo cada 30 s
    const fallback = now - lastFallback > 30000;
    if (fallback) lastFallback = now;
    const f = await P.findActiveSession(workspacePaths(), undefined, { fallback });
    if (f && (!live || live.file !== f)) attachLive(f);
    // Sin el plan B no podemos saber si la sesión actual (de una subcarpeta) sigue siendo la buena
    else if (!f && live && fallback) live = null;
  }
  const L = live;
  if (!L) { render(null); return; }
  const r = await L.reader.poll();
  if (r === 'reset') { attachLive(L.file); return; } // el siguiente tick lo vuelve a leer entero
  const sub = await pollSubagents(L);
  if (live !== L) return; // cambió la sesión mientras leíamos
  if (r || sub || !lastSummary || lastSummary.file !== L.file) {
    lastSummary = L.state.summary(cfg().get('contextWindow'), claudeEnv);
    render(lastSummary);
    if (panel) panel.webview.postMessage({ type: 'live', data: lastSummary });
  }
}

// ── Bloque de 5 horas ───────────────────────────────────────────────────────
// Tu bloque más grande, medido en tokens sin caché leída. Los bloques guardados por
// versiones anteriores no tienen ese dato y no cuentan hasta que se recalculan.
function personalMax() {
  let max = null;
  for (const b of pastBlocks) {
    if (b.end > Date.now() || typeof b.freshTokens !== 'number') continue;
    if (!max || b.freshTokens > max.freshTokens) max = b;
  }
  return max;
}

const hm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
function dur(mins) { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`; }

function getLiveBlocks() {
  if (!liveBlocks) liveBlocks = new B.LiveBlocks(pricing());
  return liveBlocks;
}

// Lee lo nuevo de los transcripts recientes y repinta si cambió algo
let blocksPolling = false;
async function pollBlocks(now, force = false) {
  if (blocksPolling) return;
  blocksPolling = true;
  try {
    const changed = await getLiveBlocks().poll(now, force);
    showBlocks(changed);
  } catch (e) { console.error('claudeMeter blocks', e); }
  finally { blocksPolling = false; }
}

// Pinta el bloque actual (sin leer archivos). `force`: repintar aunque no haya cambiado.
function showBlocks(force = false) {
  const b = getLiveBlocks().current(Date.now());
  const key = b ? `${b.start}|${b.tokens}|${b.freshTokens}|${Math.floor(b.minsLeft)}` : 'none';
  if (!force && key === lastBlockKey) return;
  lastBlockKey = key;
  lastBlock = b;
  renderBlock(b);
  updateView();
  if (panel) panel.webview.postMessage({ type: 'blocks', current: b, past: pastBlocks.slice(-30), max: personalMax() });
}

function renderBlock(b) {
  const c = cfg();
  if (!c.get('showBlock') || statusBarMode() !== 'all') { blkItem.hide(); return; }
  if (!b) {
    blkItem.text = '$(clock) 5h: —';
    blkItem.tooltip = 'No hay llamadas de Claude Code en las últimas 5 horas: el próximo mensaje abrirá un bloque nuevo.';
    blkItem.backgroundColor = undefined;
    blkItem.show();
    return;
  }
  const max = personalMax();
  const ratio = max && max.freshTokens ? b.freshTokens / max.freshTokens : 0;
  // Texto corto (la barra de estado suele ir llena): sin caché (total) · % de tu máximo · tiempo restante
  blkItem.text = `$(clock) 5h ${fmt(b.freshTokens)} (${fmt(b.tokens)})${max ? ` · ${Math.round(ratio * 100)}%` : ''} · ${dur(b.minsLeft)}`;
  blkItem.backgroundColor = ratio >= 1 ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : ratio >= c.get('blockWarnRatio') ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Bloque de 5 h actual** (estimado): ${hm(b.start)} → ${hm(b.end)}  \n`);
  md.appendMarkdown(`Se reinicia en **${dur(b.minsLeft)}**\n\n`);
  md.appendMarkdown(`_En la barra: tokens sin caché leída (total) · % de tu bloque más grande · tiempo hasta el reinicio_\n\n`);
  md.appendMarkdown(`| | |\n|---|---:|\n`);
  md.appendMarkdown(`| Tokens sin caché leída | ${fmt(b.freshTokens)} |\n| Tokens procesados (total) | ${fmt(b.tokens)} |\n`);
  md.appendMarkdown(`| Leídos de caché | ${fmt(b.tokens - b.freshTokens)} |\n| Llamadas a la API | ${b.calls} |\n`);
  if (c.get('showCost')) md.appendMarkdown(`| Coste equiv. API | ${money(b.cost)} |\n`);
  md.appendMarkdown(`| Ritmo sin caché (últimos 30 min) | ${fmt(b.perMinFresh)}/min |\n| Si sigues así, al acabar | ${fmt(b.projectedFresh)} sin caché |\n`);
  if (max) md.appendMarkdown(`| Tu bloque más grande | ${fmt(max.freshTokens)} sin caché (${new Date(max.start).toLocaleDateString('es-ES')}) |\n`);
  md.appendMarkdown(`\n_El % de tu máximo se calcula sin la caché leída: esas relecturas se repiten en cada llamada y harían parecer el total mucho mayor de lo que de verdad gastas._\n\n`);
  if (max && b.projectedFresh > max.freshTokens && ratio < 1) md.appendMarkdown(`$(warning) A este ritmo superarás tu bloque más grande antes de que se reinicie.\n\n`);
  if (!max) md.appendMarkdown(blockScanDone ? '_Aún no hay bloques anteriores para comparar._\n\n' : '_Calculando tus bloques anteriores…_\n\n');
  md.appendMarkdown(`_Suma todo Claude Code de este ordenador (todos los proyectos y subagentes). No incluye el chat de claude.ai ni otros equipos, y no es el % oficial de tu plan._\n\n`);
  md.appendMarkdown(`[$(graph) Abrir panel](command:claudeMeter.openPanel)`);
  md.isTrusted = { enabledCommands: ['claudeMeter.openPanel'] };
  blkItem.tooltip = md;
  blkItem.show();
}

// Escribe en un .tmp y renombra: si VS Code se cierra a medias, el archivo anterior sigue entero
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

let blockScanRunning = false, blockScanAgain = false;
async function scanBlocksBackground() {
  if (blockScanRunning) { blockScanAgain = true; return; }
  blockScanRunning = true;
  try {
    const since = Date.now() - 90 * 24 * 3600 * 1000;
    // Incremental: el almacén de LiveBlocks ya tiene leído todo lo anterior
    const all = await getLiveBlocks().scanAll(since);
    // fusionar con los guardados (sobreviven a la limpieza de transcripts)
    const file = path.join(ctxRef.globalStorageUri.fsPath, 'blocks.json');
    let saved = [];
    try { saved = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
    const now = Date.now();
    const byStart = new Map(saved.map(b => [b.start, b]));
    for (const b of all) if (b.end <= now) {
      const prev = byStart.get(b.start);
      // >= : con los mismos tokens se queda el recién calculado (precios actuales);
      // también sustituye a los guardados por versiones sin freshTokens
      if (!prev || b.tokens >= prev.tokens || typeof prev.freshTokens !== 'number') byStart.set(b.start, b);
    }
    pastBlocks = [...byStart.values()].sort((a, b) => a.start - b.start);
    // Ancla para el bloque en vivo: el inicio del bloque más reciente conocido
    let anchor = null;
    for (const b of all.concat(pastBlocks)) if (b.start <= now && (anchor == null || b.start > anchor)) anchor = b.start;
    getLiveBlocks().anchor = anchor;
    if (saveToDisk()) await writeJsonAtomic(file, pastBlocks);
  } catch (e) { console.error('claudeMeter: escaneo de bloques', e); }
  finally { blockScanRunning = false; }
  blockScanDone = true;
  showBlocks(true);
  if (blockScanAgain) { blockScanAgain = false; scanBlocksBackground(); }
}

// ── Barra de estado ─────────────────────────────────────────────────────────
// claudeMeter.statusBar: 'all' (los tres), 'context' (solo el contexto) o 'none'
function statusBarMode() {
  const m = cfg().get('statusBar');
  return m === 'context' || m === 'none' ? m : 'all';
}

function render(s) {
  viewLive = s;
  renderStatus(s);
  updateView();
}

function renderStatus(s) {
  const c = cfg();
  const mode = statusBarMode();
  if (mode === 'none') { ctxItem.hide(); sesItem.hide(); return; }
  if (!s) {
    ctxItem.text = '$(layers) Claude: sin sesión';
    ctxItem.tooltip = 'No hay ninguna sesión de Claude Code para esta carpeta. Clic para ver el histórico.';
    ctxItem.backgroundColor = undefined;
    sesItem.hide();
    ctxItem.show();
    return;
  }
  const pct = s.contextWindow ? (s.currentContext / s.contextWindow) * 100 : 0;
  ctxItem.text = `$(layers) ${fmt(s.currentContext)}/${fmt(s.contextWindow)} · ${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  ctxItem.backgroundColor = pct >= c.get('errorPercent') ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : pct >= c.get('warningPercent') ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  let t = `$(comment-discussion) ${s.prompts} · ${fmt(s.totalTokens)}`;
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
  ctxItem.show();
  if (mode === 'all') sesItem.show(); else sesItem.hide();
}

// ── Vista compacta (debajo del chat de Claude Code) ─────────────────────────
let view = null, viewLive = null, lastBlock = null;

// Solo lo que pinta la vista (el resumen completo lleva todas las preguntas)
function slimLive(s) {
  if (!s) return null;
  const lp = s.perPrompt[s.perPrompt.length - 1];
  return {
    project: s.project, model: shortModel(s.model),
    currentContext: s.currentContext, contextWindow: s.contextWindow, contextWindowReason: s.contextWindowReason,
    peakContext: s.peakContext, lastCallUsage: s.lastCallUsage,
    prompts: s.prompts, apiCalls: s.apiCalls, totalTokens: s.totalTokens, freshTokens: P.freshOf(s.totals),
    subTokens: P.usageTotal(s.subTotals), cost: s.cost,
    lastPrompt: lp ? {
      text: lp.text.replace(/\s+/g, ' ').slice(0, 300), ts: lp.ts, startCtx: lp.startCtx, endCtx: lp.endCtx,
      calls: lp.calls, subCalls: lp.subCalls, tokens: P.usageTotal(lp.usage), cost: lp.cost,
    } : null,
  };
}

function updateView() {
  if (!view || !view.visible) return;
  const max = personalMax();
  view.webview.postMessage({
    type: 'state',
    live: slimLive(viewLive),
    block: lastBlock,
    max: max ? { freshTokens: max.freshTokens, start: max.start } : null,
    scanDone: blockScanDone,
    cfg: { ...panelConfig(), showBlock: cfg().get('showBlock') },
  });
}

function webviewHtml(webview, script, style) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(ctxRef.extensionUri, 'media', script));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(ctxRef.extensionUri, 'media', style));
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body><main id="app"></main>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
}

const viewProvider = {
  resolveWebviewView(wv) {
    view = wv;
    wv.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctxRef.extensionUri, 'media')] };
    wv.webview.html = webviewHtml(wv.webview, 'view.js', 'view.css');
    wv.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') updateView();
      else if (m.type === 'openPanel') openPanel();
    });
    wv.onDidChangeVisibility(() => updateView());
    wv.onDidDispose(() => { if (view === wv) view = null; });
  },
};

// ── Histórico (archivo propio, sobrevive a la limpieza de 30 días de Claude) ─
function historyFile() { return path.join(ctxRef.globalStorageUri.fsPath, 'history.json'); }

// Se lee una sola vez (de forma asíncrona: puede ocupar varios MB) y se queda en memoria
let historyLoading = null;
function loadHistory() {
  if (history) return Promise.resolve(history);
  if (!historyLoading) {
    historyLoading = (async () => {
      let h = null;
      try { h = JSON.parse(await fsp.readFile(historyFile(), 'utf8')); } catch {}
      if (!h || h.version !== 2) h = { version: 2, sessions: {} };
      history = h;
      return h;
    })();
  }
  return historyLoading;
}

// Con claudeMeter.saveToDisk desactivado no se escribe nada: el histórico solo vive en memoria
const saveToDisk = () => cfg().get('saveToDisk') !== false;

async function saveHistory() {
  if (!saveToDisk() || !history) return;
  try { await writeJsonAtomic(historyFile(), history); }
  catch (e) { console.error('claudeMeter: no se pudo guardar el histórico', e); }
}

function compact(s) {
  return { ...s, perPrompt: s.perPrompt.map(p => ({ ...p, text: p.text.slice(0, 400) })) };
}

// Un solo escaneo a la vez. Quien llama mientras hay uno en curso espera a que acabe
// (antes volvía enseguida y el panel recibía un histórico a medias marcado como terminado)
// y se hace una pasada más, que solo lee lo que haya cambiado entretanto.
let historyScan = null, historyScanAgain = false;
const scanProgress = new Set();
function scanHistory(progress) {
  if (progress) scanProgress.add(progress);
  if (historyScan) { historyScanAgain = true; return historyScan; }
  historyScan = (async () => {
    try {
      do { historyScanAgain = false; await scanHistoryOnce(); } while (historyScanAgain);
    } finally { historyScan = null; scanProgress.clear(); }
  })();
  return historyScan;
}

async function scanHistoryOnce() {
  const progress = (i, n) => { for (const p of scanProgress) p(i, n); };
  {
    const h = await loadHistory();
    const files = await P.listSessionFiles();
    const present = new Set(files.map(f => f.file));
    const prices = pricing();
    const cw = cfg().get('contextWindow');
    const todo = files.filter(f => { const o = h.sessions[f.file]; return !o || o.size !== f.size || o.mtime !== f.mtime; });
    let i = 0;
    for (const f of todo) {
      try {
        const s = await P.parseSessionFile(f.file, prices, cw, claudeEnv);
        if (s.apiCalls > 0 || s.prompts > 0) h.sessions[f.file] = { size: f.size, mtime: f.mtime, s: compact(s) };
      } catch {}
      if (++i % 5 === 0) progress(i, todo.length);
    }
    for (const k of Object.keys(h.sessions)) if (!present.has(k)) h.sessions[k].deleted = true;
    if (todo.length) await saveHistory();
  }
}

// Requiere que el histórico esté cargado (await loadHistory())
function historyPayload() {
  const h = history || { sessions: {} };
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
      panel.webview.postMessage(panelConfig());
      if (lastSummary) panel.webview.postMessage({ type: 'live', data: lastSummary });
      showBlocks(true);
      await loadHistory();
      if (!panel) return;
      panel.webview.postMessage({ type: 'history', data: historyPayload(), scanning: true });
      await scanHistory((i, n) => panel && panel.webview.postMessage({ type: 'progress', i, n }));
      if (panel) panel.webview.postMessage({ type: 'history', data: historyPayload(), scanning: false });
    } else if (m.type === 'detail') {
      const o = (await loadHistory()).sessions[m.file];
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
    vscode.window.registerWebviewViewProvider('claudeMeter.view', viewProvider),
    vscode.commands.registerCommand('claudeMeter.showView', () => vscode.commands.executeCommand('claudeMeter.view.focus')),
    vscode.commands.registerCommand('claudeMeter.refresh', () => {
      live = null; lastSummary = null; lastFallback = 0;
      tick();
      pollBlocks(Date.now(), true);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { live = null; lastSummary = null; tick(); }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('claudeMeter')) return;
      restartTimer();
      if (e.affectsConfiguration('claudeMeter.priceOverrides')) applyPricing().catch(e2 => console.error('claudeMeter', e2));
      // Al volver a activar el guardado, se guarda lo que se ha acumulado en memoria
      if (e.affectsConfiguration('claudeMeter.saveToDisk') && saveToDisk()) {
        saveHistory();
        scanBlocksBackground();
      }
      if (live) lastSummary = live.state.summary(cfg().get('contextWindow'), claudeEnv);
      if (lastSummary) render(lastSummary);
      showBlocks(true);
      if (panel) {
        panel.webview.postMessage(panelConfig());
        if (lastSummary) panel.webview.postMessage({ type: 'live', data: lastSummary });
      }
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

// Aplica priceOverrides sin recargar: sesión en vivo, bloque en vivo, histórico y bloques guardados
async function applyPricing() {
  const p = pricing();
  if (live) live.state.pricing = p;
  if (liveBlocks) liveBlocks.pricing = p;
  // Las sesiones cuyo transcript sigue existiendo se vuelven a leer en el próximo escaneo
  // (las borradas por Claude Code conservan el coste con el que se guardaron).
  const h = await loadHistory();
  for (const o of Object.values(h.sessions)) if (!o.deleted) o.size = -1;
  scanBlocksBackground();
  scanHistory().then(() => {
    if (panel) panel.webview.postMessage({ type: 'history', data: historyPayload(), scanning: false });
  }).catch(() => {});
}

function restartTimer() {
  clearInterval(timer);
  timer = setInterval(tick, Math.max(500, cfg().get('pollMs') || 1500)); // tick() captura sus propios errores
}

function deactivate() {}

module.exports = { activate, deactivate };
