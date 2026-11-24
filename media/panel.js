(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const statusEl = document.getElementById('status');
  let tab = 'live', blocks = null, live = null, hist = [], detail = null, showCost = true, project = '';
  let warnPct = 60, errPct = 80, blockWarn = 0.8; // se sobrescriben con la configuración

  // Idioma: la extensión pone en <html data-l10n> el idioma de VS Code y sus traducciones
  // (vscode.l10n.bundle). Las claves son los textos en inglés; {0}, {1}… son los argumentos.
  const L10N = (() => { try { return JSON.parse(document.documentElement.dataset.l10n || '{}'); } catch { return {}; } })();
  const LOCALE = L10N.locale || 'en';
  const BUNDLE = L10N.bundle || {};
  function t(key, ...args) {
    const v = BUNDLE[key];
    const msg = typeof v === 'string' ? v : (v && v.message) || key;
    return msg.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
  }
  // Textos que pone la extensión cuando falta el dato
  const tp = (x) => (x === '(unknown)' || x === '(no prompts)' || x === '[image]' ? t(x) : x);

  // ── helpers ──
  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      // La CSP de VS Code bloquea setAttribute('style'); el CSSOM (el.style) sí está permitido
      else if (k === 'style') for (const d of String(v).split(';')) { const i = d.indexOf(':'); if (i > 0) el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); }
      else el.setAttribute(k, v);
    }
    for (const c of [].concat(kids || [])) if (c != null) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, kids) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const c of [].concat(kids || [])) if (c != null) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  function fmt(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }
  const money = (x) => '$' + (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
  const tot = (u) => u ? u.input + u.output + u.cw5m + u.cw1h + u.cacheRead : 0;
  const shortModel = (m) => (m || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const dt = (ts) => ts ? new Date(ts).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const hm = (ts) => ts ? new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : '';
  const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  function card(label, value, sub, extra) {
    return h('div', { class: 'card' }, [h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), sub ? h('div', { class: 'sub' }, sub) : null, extra || null]);
  }
  function meter(pct) {
    const cls = pct >= errPct ? 'bad' : pct >= warnPct ? 'warn' : '';
    return h('div', { class: 'meter' }, h('div', { class: 'fill ' + cls, style: 'width:' + Math.min(100, pct).toFixed(1) + '%' }));
  }

  // ── Sesión (actual o detalle) ──
  function sessionView(sm, isLive) {
    const wrap = h('div');
    if (!sm) { wrap.append(h('p', { class: 'empty' }, t('There is no active Claude Code session in this folder.'))); return wrap; }
    const pct = sm.contextWindow ? sm.currentContext / sm.contextWindow * 100 : 0;
    wrap.append(h('div', { class: 'head' }, [
      h('div', {}, [h('h2', {}, tp(sm.project)), h('div', { class: 'muted' }, [shortModel(sm.model), ' · ', dt(sm.firstTs), ' → ', dt(sm.lastTs)])]),
      h('div', { class: 'muted title' }, tp(sm.title)),
    ]));
    const cards = h('div', { class: 'cards' }, [
      card(isLive ? t('Current context') : t('Final context'), fmt(sm.currentContext), t('{0}% of {1} · peak {2}', pct.toFixed(1), fmt(sm.contextWindow), fmt(sm.peakContext)), meter(pct)),
      card(t('Tokens processed'), fmt(sm.totalTokens), t('cache read {0} · output {1}', fmt(sm.totals.cacheRead), fmt(sm.totals.output))),
      card(t('Prompts'), String(sm.prompts), t('{0} API calls', sm.apiCalls)),
    ]);
    if (showCost) cards.append(card(t('API-equivalent cost'), money(sm.cost), t('approx., not what you pay with Pro/Max')));
    if (tot(sm.subTotals) > 0) cards.append(card(t('Subagents'), fmt(tot(sm.subTotals)), t('included in the total')));
    wrap.append(cards);

    const pp = sm.perPrompt || [];
    if (pp.length) {
      wrap.append(h('h3', {}, t('Context carried by each prompt')));
      wrap.append(contextChart(pp, sm.contextWindow));
      wrap.append(h('h3', {}, t('Prompts')));
      const rows = pp.map((p, i) => h('tr', { class: p.compactBefore ? 'compact' : '' }, [
        h('td', { class: 'num' }, String(i + 1)),
        h('td', { class: 'muted' }, hm(p.ts)),
        h('td', { class: 'q', title: tp(p.text) }, [p.compactBefore ? h('span', { class: 'tag' }, t('compacted')) : null, tp(p.text).replace(/\s+/g, ' ').slice(0, 160)]),
        h('td', { class: 'num' }, p.startCtx == null ? '—' : fmt(p.startCtx)),
        h('td', { class: 'num' }, fmt(p.endCtx)),
        h('td', { class: 'num' }, String(p.calls) + (p.subCalls ? ' +' + p.subCalls : '')),
        h('td', { class: 'num' }, fmt(p.usage.output)),
        h('td', { class: 'num' }, fmt(tot(p.usage))),
        showCost ? h('td', { class: 'num' }, money(p.cost)) : null,
      ]));
      wrap.append(h('table', {}, [
        h('thead', {}, h('tr', {}, [h('th', {}, '#'), h('th', {}, t('Time')), h('th', {}, t('Prompt')),
          h('th', { title: t('Context tokens sent in the first call of this prompt') }, t('Ctx start')),
          h('th', { title: t('Context when the answer finished') }, t('Ctx end')),
          h('th', { title: t('API calls (+ subagent calls)') }, t('Calls')),
          h('th', {}, t('Output')), h('th', { title: t('Tokens processed (includes cache reads)') }, t('Total')),
          showCost ? h('th', {}, t('Cost')) : null])),
        h('tbody', {}, rows.reverse()),
      ]));
    }
    return wrap;
  }

  function contextChart(pp, win) {
    const W = 800, H = 150, pad = 4;
    const vals = pp.map(p => p.endCtx || 0);
    const max = Math.max(...vals, 1);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H + 18}`, class: 'chart', preserveAspectRatio: 'none' });
    const bw = (W - pad * 2) / vals.length;
    vals.forEach((v, i) => {
      const bh = Math.max(1, v / max * H);
      const pct = win ? v / win * 100 : 0;
      const r = s('rect', { x: pad + i * bw + 1, y: H - bh, width: Math.max(1, bw - 2), height: bh, class: 'bar' + (pct >= errPct ? ' bad' : pct >= warnPct ? ' warn' : '') + (pp[i].compactBefore ? ' cmp' : '') });
      r.append(s('title', {}, `#${i + 1} · ${fmt(v)} tokens (${pct.toFixed(1)}%)\n${tp(pp[i].text).slice(0, 100)}`));
      svg.append(r);
    });
    svg.append(s('text', { x: pad, y: H + 14, class: 'axis' }, t('max {0} · window {1}', fmt(max), fmt(win))));
    return svg;
  }

  // ── Histórico ──
  function histView() {
    if (detail) {
      return h('div', {}, [h('button', { class: 'back', onclick: () => { detail = null; render(); } }, '← ' + t('Back to history')), sessionView(detail, false)]);
    }
    const wrap = h('div');
    const projects = [...new Set(hist.map(x => x.project))].sort();
    const list = hist.filter(x => !project || x.project === project);
    const now = new Date();
    const today = dayKey(now);
    const since = (days) => { const d = new Date(now); d.setDate(d.getDate() - days + 1); return dayKey(d); };
    const agg = (from) => list.filter(x => x.lastTs && dayKey(x.lastTs) >= from).reduce((a, x) => ({ t: a.t + x.totalTokens, c: a.c + x.cost, n: a.n + 1, q: a.q + x.prompts }), { t: 0, c: 0, n: 0, q: 0 });
    const cards = [[t('Today'), agg(today)], [t('7 days'), agg(since(7))], [t('30 days'), agg(since(30))], [t('Total saved'), agg('0000')]];
    wrap.append(h('div', { class: 'filters' }, [
      h('label', {}, t('Project:') + ' '),
      h('select', { onchange: (e) => { project = e.target.value; render(); } },
        [h('option', { value: '' }, t('All'))].concat(projects.map(p => { const o = h('option', { value: p }, tp(p)); if (p === project) o.selected = true; return o; }))),
    ]));
    wrap.append(h('div', { class: 'cards' }, cards.map(([l, a]) => card(l, fmt(a.t) + ' tok', t('{0} sessions · {1} prompts', a.n, a.q) + (showCost ? ' · ' + money(a.c) : '')))));

    // tokens por día (30 días)
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); days.push(dayKey(d)); }
    const per = Object.fromEntries(days.map(d => [d, 0]));
    for (const x of list) if (x.lastTs) { const k = dayKey(x.lastTs); if (k in per) per[k] += x.totalTokens; }
    const W = 800, H = 110, max = Math.max(...Object.values(per), 1), bw = W / days.length;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H + 18}`, class: 'chart', preserveAspectRatio: 'none' });
    days.forEach((d, i) => {
      const v = per[d], bh = v ? Math.max(2, v / max * H) : 0;
      const r = s('rect', { x: i * bw + 1, y: H - bh, width: bw - 2, height: bh, class: 'bar' });
      r.append(s('title', {}, d + ': ' + fmt(v) + ' tokens'));
      svg.append(r);
      if (i % 5 === 0 || i === 29) svg.append(s('text', { x: i * bw + 1, y: H + 14, class: 'axis' }, d.slice(5)));
    });
    wrap.append(h('h3', {}, t('Tokens per day (last 30 days)')), svg);

    wrap.append(blocksView());
    wrap.append(h('h3', {}, t('Sessions ({0})', list.length)));
    const rows = list.slice().sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')).map(x => h('tr', {
      class: 'click' + (x.deleted ? ' gone' : ''), onclick: () => vscode.postMessage({ type: 'detail', file: x.file }),
      title: x.deleted ? t('Claude Code already deleted this transcript; the summary is kept') : x.file,
    }, [
      h('td', { class: 'muted' }, dt(x.lastTs)),
      h('td', {}, tp(x.project)),
      h('td', { class: 'q' }, tp(x.title).replace(/\s+/g, ' ').slice(0, 110)),
      h('td', { class: 'num' }, String(x.prompts)),
      h('td', { class: 'num' }, fmt(x.peakContext)),
      h('td', { class: 'num' }, fmt(x.totalTokens)),
      h('td', { class: 'muted' }, shortModel(x.model)),
      showCost ? h('td', { class: 'num' }, money(x.cost)) : null,
    ]));
    wrap.append(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', {}, t('Last update')), h('th', {}, t('Project')), h('th', {}, t('Session')), h('th', {}, t('Prompts')),
        h('th', {}, t('Peak ctx')), h('th', {}, t('Tokens')), h('th', {}, t('Model')), showCost ? h('th', {}, t('Cost')) : null])),
      h('tbody', {}, rows),
    ]));
    if (!list.length) wrap.append(h('p', { class: 'empty' }, t('No saved sessions yet.')));
    return wrap;
  }

  function blocksView() {
    const w = h('div');
    w.append(h('h3', {}, t('5-hour blocks (all Claude Code on this computer)')));
    if (!blocks) { w.append(h('p', { class: 'muted' }, t('Calculating…'))); return w; }
    // El máximo y la barra usan tokens sin caché leída (igual que la barra de estado)
    const max = blocks.max && typeof blocks.max.freshTokens === 'number' ? blocks.max.freshTokens : 0;
    const fresh = (b) => typeof b.freshTokens === 'number' ? b.freshTokens : null;
    const when = (ms) => new Date(ms).toLocaleString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rowsData = (blocks.past || []).slice(-15).reverse();
    const rows = [];
    const mk = (b, isCur) => h('tr', { class: isCur ? 'cur' : '' }, [
      h('td', {}, [isCur ? h('span', { class: 'tag' }, t('now')) : null, when(b.start)]),
      h('td', { class: 'num' }, fresh(b) == null ? '—' : fmt(fresh(b))),
      h('td', { class: 'num muted' }, fmt(b.tokens)),
      h('td', { class: 'barcell' }, h('div', { class: 'meter' }, h('div', { class: 'fill' + (max && fresh(b) >= max ? ' bad' : max && fresh(b) >= max * blockWarn ? ' warn' : ''), style: 'width:' + (max && fresh(b) != null ? Math.min(100, fresh(b) / max * 100) : 0).toFixed(1) + '%' }))),
      h('td', { class: 'num' }, String(b.calls)),
      showCost ? h('td', { class: 'num' }, money(b.cost)) : null,
    ]);
    if (blocks.current) rows.push(mk(blocks.current, true));
    for (const b of rowsData) rows.push(mk(b, false));
    if (!rows.length) { w.append(h('p', { class: 'muted' }, t('No blocks yet.'))); return w; }
    w.append(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', {}, t('Start')),
        h('th', { title: t('New input + output + cache writes (without cache reads)') }, t('Uncached')),
        h('th', { title: t('Includes cache reads') }, t('Total')),
        h('th', { title: t('Uncached tokens compared with your largest block') }, t('Compared with your max')), h('th', {}, t('Calls')), showCost ? h('th', {}, t('Cost')) : null])),
      h('tbody', {}, rows),
    ]));
    return w;
  }

  function render() {
    const y = window.scrollY;
    app.replaceChildren(tab === 'live' ? sessionView(live, true) : histView());
    window.scrollTo(0, y);
  }

  document.querySelectorAll('nav [data-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('nav [data-tab]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); tab = b.dataset.tab; detail = null; render();
  }));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'config') {
      showCost = m.showCost;
      if (typeof m.warningPercent === 'number') warnPct = m.warningPercent;
      if (typeof m.errorPercent === 'number') errPct = m.errorPercent;
      if (typeof m.blockWarnRatio === 'number') blockWarn = m.blockWarnRatio;
      render();
    }
    else if (m.type === 'live') { live = m.data; if (tab === 'live') render(); }
    else if (m.type === 'history') { hist = m.data; statusEl.textContent = m.scanning ? t('Reading sessions…') : ''; if (tab === 'hist') render(); }
    else if (m.type === 'progress') statusEl.textContent = t('Reading sessions…') + ' ' + m.i + '/' + m.n;
    else if (m.type === 'blocks') { blocks = m; if (tab === 'hist' && !detail) render(); }
    else if (m.type === 'detail') { detail = m.data; tab = 'hist'; render(); }
  });
  vscode.postMessage({ type: 'ready' });
  render();
})();
