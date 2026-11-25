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

// ── Idioma ──────────────────────────────────────────────────────────────────
// Los textos son claves en inglés: vscode.l10n.t las traduce con l10n/bundle.l10n.<idioma>.json.
// Las webviews reciben el mismo diccionario (vscode.l10n.bundle) y el idioma de VS Code.
const t = vscode.l10n.t;
const locale = () => vscode.env.language || 'en';
// Textos que pone parser.js (sin acceso a vscode): se traducen al mostrarlos
const PLACEHOLDERS = new Set(['(unknown)', '(no prompts)', '[image]']);
const tp = (x) => PLACEHOLDERS.has(x) ? t(x) : x;
const num = (n) => Math.round(n || 0).toLocaleString(locale());

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
// Uso oficial (de ~/.claude.json, lo guarda Claude Code al consultar a Anthropic)
let official = null, lastOfficialRead = 0;
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
  if (now - lastOfficialRead > 15000) {
    lastOfficialRead = now;
    const o = await P.readOfficialUsage();
    if (o !== official) {
      official = o;
      getLiveBlocks().officialReset = o && o.fiveHour ? o.fiveHour.resetsAt : null;
      showBlocks(true);
    }
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
  // Proyecto abierto para el reparto del bloque: carpetas de la ventana + la del chat activo
  const dirs = new Set(workspacePaths().map(p => P.encodeProjectDir(p).toLowerCase()));
  if (live) dirs.add(path.basename(path.dirname(live.file)).toLowerCase());
  const lb = getLiveBlocks();
  if (!lb.projectDirs || [...dirs].sort().join() !== [...lb.projectDirs].sort().join()) { lb.projectDirs = dirs; showBlocks(true); }
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

const hm = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
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
  // Incluye el minuto actual y el dato oficial: la cuenta atrás oficial avanza aunque no haya actividad aquí
  const key = (b ? `${b.start}|${b.tokens}|${b.freshTokens}` : 'none') + `|${Math.floor(Date.now() / 60000)}|${official ? official.fetchedAt : ''}`;
  if (!force && key === lastBlockKey) return;
  lastBlockKey = key;
  lastBlock = b;
  renderBlock(b);
  updateView();
  if (panel) panel.webview.postMessage({ type: 'blocks', current: b, past: pastBlocks.slice(-30), max: personalMax() });
}

// Uso oficial válido ahora mismo: la ventana de 5 h solo vale si aún no se ha reiniciado
function officialState(now = Date.now()) {
  const o = official;
  if (!o) return null;
  const five = o.fiveHour && o.fiveHour.resetsAt > now ? o.fiveHour : null;
  const week = o.sevenDay && o.sevenDay.resetsAt > now ? o.sevenDay : null;
  return {
    five, week,
    expiredAt: o.fiveHour && o.fiveHour.resetsAt <= now ? o.fiveHour.resetsAt : null,
    fetchedAt: o.fetchedAt,
    breakdown: o.weeklyBreakdown || [],
  };
}

const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? t('just now') : t('{0} ago', m < 60 ? `${m} min` : dur(m));
};
const dayTime = (ms) => new Date(ms).toLocaleString(locale(), { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function renderBlock(b) {
  const c = cfg();
  if (!c.get('showBlock') || statusBarMode() !== 'all') { blkItem.hide(); return; }
  const now = Date.now();
  const off = officialState(now);
  const max = personalMax();
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;

  if (off && off.five) {
    // Dato oficial: % de la ventana y hora de reinicio que da Anthropic
    const pct = off.five.pct;
    const mins = (off.five.resetsAt - now) / 60000;
    blkItem.text = `$(clock) 5h ${pct}% · ${dur(mins)}`;
    blkItem.backgroundColor = pct >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : pct >= c.get('blockWarnRatio') * 100 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    md.appendMarkdown(t('**5-hour limit: {0}% used** (official data)', pct) + '  \n');
    md.appendMarkdown(t('Resets at **{0}** (in {1})', hm(off.five.resetsAt), dur(mins)) + '  \n');
    if (off.week) md.appendMarkdown(t('Weekly limit: **{0}%** · resets {1}', off.week.pct, dayTime(off.week.resetsAt)) + '  \n');
    if (off.fetchedAt) md.appendMarkdown('_' + t('Claude Code data from {0}; it updates when Claude Code checks it (for example with /usage).', ago(off.fetchedAt)) + '_\n\n');
  } else if (b) {
    const ratio = max && max.freshTokens ? b.freshTokens / max.freshTokens : 0;
    blkItem.text = `$(clock) 5h ${fmt(b.freshTokens)} (${fmt(b.tokens)})${max ? ` · ${Math.round(ratio * 100)}%` : ''} · ${dur(b.minsLeft)}`;
    blkItem.backgroundColor = ratio >= 1 ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : ratio >= c.get('blockWarnRatio') ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    md.appendMarkdown((b.alignedToOfficial
      ? t('**5-hour block**: {0} → {1}, resets in **{2}**', hm(b.start), hm(b.end), dur(b.minsLeft))
      : t('**5-hour block** (estimated): {0} → {1}, resets in **{2}**', hm(b.start), hm(b.end), dur(b.minsLeft))) + '  \n');
    if (off && off.expiredAt) md.appendMarkdown('_' + t('The official window reset at {0}; the new % will appear when Claude Code checks it again (for example with /usage).', hm(off.expiredAt)) + '_\n\n');
    else md.appendMarkdown('_' + t('In the bar: tokens without cache reads (total) · % of your largest block · time until reset. No official data: Claude Code has not saved your plan usage yet.') + '_\n\n');
  } else {
    blkItem.text = '$(clock) 5h: —';
    blkItem.backgroundColor = undefined;
    md.appendMarkdown(off && off.expiredAt
      ? t('The 5-hour window reset at {0}. The next one starts with your next message (here, on claude.ai or in Cowork).', hm(off.expiredAt)) + '\n\n'
      : t('No Claude Code calls in the last 5 hours: your next message will start a new block.') + '\n\n');
  }

  if (b) {
    md.appendMarkdown(`| ${t('This computer, in this window')} | |\n|---|---:|\n`);
    md.appendMarkdown(`| ${t('Tokens without cache reads')} | ${fmt(b.freshTokens)} |\n| ${t('Tokens processed (total)')} | ${fmt(b.tokens)} |\n| ${t('API calls')} | ${b.calls} |\n`);
    if (c.get('showCost')) md.appendMarkdown(`| ${t('API-equivalent cost')} | ${money(b.cost)} |\n`);
    md.appendMarkdown(`| ${t('Rate without cache (30 min)')} | ${fmt(b.perMinFresh)}/min |\n`);
    if (max) md.appendMarkdown(`| ${t('Your largest block')} | ${t('{0} without cache ({1})', fmt(max.freshTokens), new Date(max.start).toLocaleDateString(locale()))} |\n`);
    md.appendMarkdown('\n_' + t('Tokens only count Claude Code on this computer: they do not include claude.ai, Cowork or other computers.') + '_\n\n');
  }
  md.appendMarkdown(`[$(graph) ${t('Open panel')}](command:claudeMeter.openPanel)`);
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
    try {
      const j = await readStorageJson('blocks.json');
      saved = Array.isArray(j) ? j : (j && Array.isArray(j.blocks) ? j.blocks : []);
    } catch {}
    const now = Date.now();
    const ended = all.filter(b => b.end <= now);
    // Los recalculados mandan en su franja horaria: un bloque guardado que se solapa con uno
    // recalculado se descarta (p. ej. los de versiones anteriores, redondeados a la hora).
    // Excepción: mismo inicio y más tokens guardados (Claude Code borró parte de esos transcripts).
    const merged = [];
    for (const s of saved) {
      if (typeof s.start !== 'number' || typeof s.end !== 'number') continue;
      const over = ended.filter(b => b.start < s.end && s.start < b.end);
      if (!over.length) merged.push(s);
      else if (over.length === 1 && over[0].start === s.start && s.tokens > over[0].tokens && typeof s.freshTokens === 'number') {
        merged.push(s); ended.splice(ended.indexOf(over[0]), 1);
      }
    }
    pastBlocks = merged.concat(ended).sort((a, b) => a.start - b.start);
    // Ancla para el bloque en vivo: el inicio del bloque más reciente conocido
    let anchor = null;
    for (const b of all.concat(pastBlocks)) if (b.start <= now && (anchor == null || b.start > anchor)) anchor = b.start;
    getLiveBlocks().anchor = anchor;
    if (saveToDisk()) await writeJsonAtomic(file, { version: 2, blocks: pastBlocks });
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
    ctxItem.text = '$(layers) ' + t('Claude: no session');
    ctxItem.tooltip = t('There is no Claude Code session for this folder. Click to see the history.');
    ctxItem.backgroundColor = undefined;
    sesItem.hide();
    ctxItem.show();
    return;
  }
  const pct = s.contextWindow ? (s.currentContext / s.contextWindow) * 100 : 0;
  ctxItem.text = `$(layers) ${fmt(s.currentContext)}/${fmt(s.contextWindow)} · ${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  ctxItem.backgroundColor = pct >= c.get('errorPercent') ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : pct >= c.get('warningPercent') ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  let text = `$(comment-discussion) ${s.prompts} · ${fmt(s.totalTokens)}`;
  if (c.get('showCost')) text += ` · ${money(s.cost)}`;
  sesItem.text = text;

  const lp = s.perPrompt[s.perPrompt.length - 1];
  const u = s.lastCallUsage;
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Claude Code · ${tp(s.project)}** — ${shortModel(s.model)}\n\n`);
  md.appendMarkdown(t('**Current context:** {0} tokens ({1}% of {2})', num(s.currentContext), pct.toFixed(1), fmt(s.contextWindow)) + '  \n');
  md.appendMarkdown(t('{0} window: {1}', fmt(s.contextWindow), t(s.contextWindowReason)) + '  \n' + t('Session peak: {0}', fmt(s.peakContext)) + '\n\n');
  md.appendMarkdown(`| ${t('Last call')} | ${t('Tokens')} |\n|---|---:|\n`);
  md.appendMarkdown(`| ${t('Read from cache')} | ${fmt(u.cacheRead)} |\n| ${t('Written to cache')} | ${fmt(u.cw5m + u.cw1h)} |\n| ${t('New input')} | ${fmt(u.input)} |\n| ${t('Output')} | ${fmt(u.output)} |\n\n`);
  md.appendMarkdown(t('**Session:** {0} prompts · {1} calls · {2} tokens processed', s.prompts, s.apiCalls, fmt(s.totalTokens)));
  if (c.get('showCost')) md.appendMarkdown(' · ' + t('{0} (API equiv.)', money(s.cost)));
  md.appendMarkdown('\n\n');
  if (s.subTotals && P.usageTotal(s.subTotals) > 0) md.appendMarkdown(t('Subagents: {0} tokens', fmt(P.usageTotal(s.subTotals))) + '\n\n');
  if (lp) {
    const txt = tp(lp.text).replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]|<>]/g, ' ').slice(0, 90);
    md.appendMarkdown(`**${t('Last prompt:')}** _${txt}${lp.text.length > 90 ? '…' : ''}_  \n`);
    md.appendMarkdown(t('{0} calls · {1} tokens', lp.calls, fmt(P.usageTotal(lp.usage))));
    if (c.get('showCost')) md.appendMarkdown(` · ${money(lp.cost)}`);
    md.appendMarkdown('\n\n');
  }
  md.appendMarkdown(`[$(graph) ${t('Open panel')}](command:claudeMeter.openPanel)`);
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
    firstTs: s.firstTs, lastTs: s.lastTs, title: String(s.title || '').replace(/\s+/g, ' ').slice(0, 200),
    firstCallUsage: s.firstCallUsage,
    currentContext: s.currentContext, contextWindow: s.contextWindow, contextWindowReason: s.contextWindowReason,
    peakContext: s.peakContext, lastCallUsage: s.lastCallUsage,
    prompts: s.prompts, apiCalls: s.apiCalls, totalTokens: s.totalTokens, freshTokens: P.freshOf(s.totals),
    subTokens: P.usageTotal(s.subTotals), cost: s.cost, totals: s.totals,
    lastPrompt: lp ? {
      text: lp.text.replace(/\s+/g, ' ').slice(0, 300), ts: lp.ts, startCtx: lp.startCtx, endCtx: lp.endCtx,
      calls: lp.calls, subCalls: lp.subCalls, tokens: P.usageTotal(lp.usage), cost: lp.cost,
    } : null,
  };
}

// Nombre legible de cada proyecto: la última carpeta de su cwd (se lee una vez, en segundo plano)
const projectNames = new Map();
function projectName(proj) {
  const n = projectNames.get(proj);
  if (n) return n;
  const file = liveBlocks && liveBlocks.store.projectFiles.get(proj);
  if (file && !projectNames.has(proj)) {
    projectNames.set(proj, null); // en curso
    P.readCwd(file).then((cwd) => {
      if (cwd) { projectNames.set(proj, cwd.split(/[\\/]/).filter(Boolean).pop() || cwd); updateView(); }
      else projectNames.delete(proj);
    }).catch(() => projectNames.delete(proj));
  }
  return proj; // mientras tanto, el nombre de la carpeta de ~/.claude/projects
}

function slimBlock(b) {
  if (!b) return null;
  const { projects, models, ...rest } = b;
  const dirs = liveBlocks && liveBlocks.projectDirs;
  return {
    ...rest,
    projects: (projects || []).slice(0, 6).map(p => ({
      name: projectName(p.proj), current: !!(dirs && dirs.has(p.proj)),
      freshTokens: p.freshTokens, tokens: p.tokens, calls: p.calls, recentFresh: p.recentFresh,
    })),
    otherProjects: Math.max(0, (projects || []).length - 6),
  };
}

function updateView() {
  if (!view || !view.visible) return;
  const max = personalMax();
  view.webview.postMessage({
    type: 'state',
    live: slimLive(viewLive),
    block: slimBlock(lastBlock),
    official: officialState(),
    max: max ? { freshTokens: max.freshTokens, start: max.start } : null,
    scanDone: blockScanDone,
    cfg: { ...panelConfig(), showBlock: cfg().get('showBlock'), viewMode: cfg().get('viewMode') === 'simple' ? 'simple' : 'detailed', contextTips: cfg().get('contextTips') !== false },
  });
}

// Idioma de VS Code y traducciones para las webviews, como JSON en un atributo (sin scripts en línea)
function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function l10nAttr() { return esc(JSON.stringify({ locale: locale(), bundle: vscode.l10n.bundle || {} })); }

function webviewHtml(webview, script, style, body = '<main id="app"></main>') {
  const nonce = crypto.randomBytes(16).toString('hex');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(ctxRef.extensionUri, 'media', script));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(ctxRef.extensionUri, 'media', style));
  return `<!DOCTYPE html><html lang="${esc(locale())}" data-l10n="${l10nAttr()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>${body}
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
      else if (m.type === 'setViewMode' && (m.mode === 'simple' || m.mode === 'detailed')) {
        // Se guarda como ajuste de usuario: así se recuerda al reiniciar VS Code
        Promise.resolve(cfg().update('viewMode', m.mode, vscode.ConfigurationTarget.Global)).then(updateView, e => console.error('claudeMeter', e));
      }
    });
    wv.onDidChangeVisibility(() => updateView());
    wv.onDidDispose(() => { if (view === wv) view = null; });
  },
};

// ── Histórico (archivo propio, sobrevive a la limpieza de 30 días de Claude) ─
function historyFile() { return path.join(ctxRef.globalStorageUri.fsPath, 'history.json'); }

// Identificadores anteriores de esta misma extensión (VS Code guarda los datos en una carpeta
// con el identificador en minúsculas). Si aún no hay datos propios, se leen de ahí: solo
// lectura, nunca se borran; lo siguiente que se guarde ya va a la carpeta actual.
const LEGACY_IDS = ['manuelcebreiro.claude-context-meter'];
async function readStorageJson(name) {
  const own = path.join(ctxRef.globalStorageUri.fsPath, name);
  try { return JSON.parse(await fsp.readFile(own, 'utf8')); } catch {}
  const root = path.dirname(ctxRef.globalStorageUri.fsPath);
  for (const id of LEGACY_IDS) {
    const old = path.join(root, id, name);
    if (old === own) continue;
    try { return JSON.parse(await fsp.readFile(old, 'utf8')); } catch {}
  }
  return null;
}

// Se lee una sola vez (de forma asíncrona: puede ocupar varios MB) y se queda en memoria
let historyLoading = null;
function loadHistory() {
  if (history) return Promise.resolve(history);
  if (!historyLoading) {
    historyLoading = (async () => {
      let h = null;
      h = await readStorageJson('history.json');
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
  panel = vscode.window.createWebviewPanel('claudeMeter', t('Claude · Tokens'), vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctxRef.extensionUri, 'media')],
  });
  panel.webview.html = webviewHtml(panel.webview, 'panel.js', 'panel.css',
    `<nav><button data-tab="live" class="on">${esc(t('Current session'))}</button><button data-tab="hist">${esc(t('History'))}</button>
<span class="sp"></span><span id="status"></span><button id="refresh">↻ ${esc(t('Refresh'))}</button></nav>
<main id="app"></main>`);
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
  ctxItem.name = t('Claude · context');
  ctxItem.command = 'claudeMeter.openPanel';
  sesItem = vscode.window.createStatusBarItem('claudeMeter.session', vscode.StatusBarAlignment.Right, 999);
  sesItem.name = t('Claude · session');
  sesItem.command = 'claudeMeter.openPanel';
  blkItem = vscode.window.createStatusBarItem('claudeMeter.block', vscode.StatusBarAlignment.Right, 998);
  blkItem.name = t('Claude · 5-hour block');
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
