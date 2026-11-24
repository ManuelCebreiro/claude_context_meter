(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const statusEl = document.getElementById('status');
  let tab = 'live', blocks = null, live = null, hist = [], detail = null, showCost = true, project = '';
  let warnPct = 60, errPct = 80, blockWarn = 0.8; // se sobrescriben con la configuración

  // ── helpers ──
  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.setAttribute('style', v);
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
  const dt = (ts) => ts ? new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const hm = (ts) => ts ? new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
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
    if (!sm) { wrap.append(h('p', { class: 'empty' }, 'No hay ninguna sesión de Claude Code activa en esta carpeta.')); return wrap; }
    const pct = sm.contextWindow ? sm.currentContext / sm.contextWindow * 100 : 0;
    wrap.append(h('div', { class: 'head' }, [
      h('div', {}, [h('h2', {}, sm.project), h('div', { class: 'muted' }, [shortModel(sm.model), ' · ', dt(sm.firstTs), ' → ', dt(sm.lastTs)])]),
      h('div', { class: 'muted title' }, sm.title),
    ]));
    const cards = h('div', { class: 'cards' }, [
      card(isLive ? 'Contexto actual' : 'Contexto final', fmt(sm.currentContext), pct.toFixed(1) + '% de ' + fmt(sm.contextWindow) + ' · pico ' + fmt(sm.peakContext), meter(pct)),
      card('Tokens procesados', fmt(sm.totalTokens), 'caché leída ' + fmt(sm.totals.cacheRead) + ' · salida ' + fmt(sm.totals.output)),
      card('Preguntas', String(sm.prompts), sm.apiCalls + ' llamadas a la API'),
    ]);
    if (showCost) cards.append(card('Coste equiv. API', money(sm.cost), 'aprox., no es lo que pagas con Pro/Max'));
    if (tot(sm.subTotals) > 0) cards.append(card('Subagentes', fmt(tot(sm.subTotals)), 'incluidos en el total'));
    wrap.append(cards);

    const pp = sm.perPrompt || [];
    if (pp.length) {
      wrap.append(h('h3', {}, 'Contexto que arrastra cada pregunta'));
      wrap.append(contextChart(pp, sm.contextWindow));
      wrap.append(h('h3', {}, 'Preguntas'));
      const rows = pp.map((p, i) => h('tr', { class: p.compactBefore ? 'compact' : '' }, [
        h('td', { class: 'num' }, String(i + 1)),
        h('td', { class: 'muted' }, hm(p.ts)),
        h('td', { class: 'q', title: p.text }, [p.compactBefore ? h('span', { class: 'tag' }, 'compactado') : null, p.text.replace(/\s+/g, ' ').slice(0, 160)]),
        h('td', { class: 'num' }, p.startCtx == null ? '—' : fmt(p.startCtx)),
        h('td', { class: 'num' }, fmt(p.endCtx)),
        h('td', { class: 'num' }, String(p.calls) + (p.subCalls ? ' +' + p.subCalls : '')),
        h('td', { class: 'num' }, fmt(p.usage.output)),
        h('td', { class: 'num' }, fmt(tot(p.usage))),
        showCost ? h('td', { class: 'num' }, money(p.cost)) : null,
      ]));
      wrap.append(h('table', {}, [
        h('thead', {}, h('tr', {}, [h('th', {}, '#'), h('th', {}, 'Hora'), h('th', {}, 'Pregunta'),
          h('th', { title: 'Tokens de contexto enviados en la primera llamada de esta pregunta' }, 'Ctx inicio'),
          h('th', { title: 'Contexto al terminar de responder' }, 'Ctx fin'),
          h('th', { title: 'Llamadas a la API (+ de subagentes)' }, 'Llam.'),
          h('th', {}, 'Salida'), h('th', { title: 'Tokens procesados (incluye relecturas de caché)' }, 'Total'),
          showCost ? h('th', {}, 'Coste') : null])),
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
      r.append(s('title', {}, `#${i + 1} · ${fmt(v)} tokens (${pct.toFixed(1)}%)\n${pp[i].text.slice(0, 100)}`));
      svg.append(r);
    });
    svg.append(s('text', { x: pad, y: H + 14, class: 'axis' }, 'máx ' + fmt(max) + ' · ventana ' + fmt(win)));
    return svg;
  }

  // ── Histórico ──
  function histView() {
    if (detail) {
      return h('div', {}, [h('button', { class: 'back', onclick: () => { detail = null; render(); } }, '← Volver al histórico'), sessionView(detail, false)]);
    }
    const wrap = h('div');
    const projects = [...new Set(hist.map(x => x.project))].sort();
    const list = hist.filter(x => !project || x.project === project);
    const now = new Date();
    const today = dayKey(now);
    const since = (days) => { const d = new Date(now); d.setDate(d.getDate() - days + 1); return dayKey(d); };
    const agg = (from) => list.filter(x => x.lastTs && dayKey(x.lastTs) >= from).reduce((a, x) => ({ t: a.t + x.totalTokens, c: a.c + x.cost, n: a.n + 1, q: a.q + x.prompts }), { t: 0, c: 0, n: 0, q: 0 });
    const cards = [['Hoy', agg(today)], ['7 días', agg(since(7))], ['30 días', agg(since(30))], ['Total guardado', agg('0000')]];
    wrap.append(h('div', { class: 'filters' }, [
      h('label', {}, 'Proyecto: '),
      h('select', { onchange: (e) => { project = e.target.value; render(); } },
        [h('option', { value: '' }, 'Todos')].concat(projects.map(p => { const o = h('option', { value: p }, p); if (p === project) o.selected = true; return o; }))),
    ]));
    wrap.append(h('div', { class: 'cards' }, cards.map(([l, a]) => card(l, fmt(a.t) + ' tok', a.n + ' sesiones · ' + a.q + ' preguntas' + (showCost ? ' · ' + money(a.c) : '')))));

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
    wrap.append(h('h3', {}, 'Tokens por día (últimos 30 días)'), svg);

    wrap.append(blocksView());
    wrap.append(h('h3', {}, 'Sesiones (' + list.length + ')'));
    const rows = list.slice().sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')).map(x => h('tr', {
      class: 'click' + (x.deleted ? ' gone' : ''), onclick: () => vscode.postMessage({ type: 'detail', file: x.file }),
      title: x.deleted ? 'Claude Code ya borró este transcript; se conserva el resumen' : x.file,
    }, [
      h('td', { class: 'muted' }, dt(x.lastTs)),
      h('td', {}, x.project),
      h('td', { class: 'q' }, x.title.replace(/\s+/g, ' ').slice(0, 110)),
      h('td', { class: 'num' }, String(x.prompts)),
      h('td', { class: 'num' }, fmt(x.peakContext)),
      h('td', { class: 'num' }, fmt(x.totalTokens)),
      h('td', { class: 'muted' }, shortModel(x.model)),
      showCost ? h('td', { class: 'num' }, money(x.cost)) : null,
    ]));
    wrap.append(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', {}, 'Última act.'), h('th', {}, 'Proyecto'), h('th', {}, 'Sesión'), h('th', {}, 'Preg.'),
        h('th', {}, 'Pico ctx'), h('th', {}, 'Tokens'), h('th', {}, 'Modelo'), showCost ? h('th', {}, 'Coste') : null])),
      h('tbody', {}, rows),
    ]));
    if (!list.length) wrap.append(h('p', { class: 'empty' }, 'Aún no hay sesiones guardadas.'));
    return wrap;
  }

  function blocksView() {
    const w = h('div');
    w.append(h('h3', {}, 'Bloques de 5 horas (todo Claude Code de este ordenador)'));
    if (!blocks) { w.append(h('p', { class: 'muted' }, 'Calculando…')); return w; }
    // El máximo y la barra usan tokens sin caché leída (igual que la barra de estado)
    const max = blocks.max && typeof blocks.max.freshTokens === 'number' ? blocks.max.freshTokens : 0;
    const fresh = (b) => typeof b.freshTokens === 'number' ? b.freshTokens : null;
    const t = (ms) => new Date(ms).toLocaleString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rowsData = (blocks.past || []).slice(-15).reverse();
    const rows = [];
    const mk = (b, isCur) => h('tr', { class: isCur ? 'cur' : '' }, [
      h('td', {}, [isCur ? h('span', { class: 'tag' }, 'ahora') : null, t(b.start)]),
      h('td', { class: 'num' }, fresh(b) == null ? '—' : fmt(fresh(b))),
      h('td', { class: 'num muted' }, fmt(b.tokens)),
      h('td', { class: 'barcell' }, h('div', { class: 'meter' }, h('div', { class: 'fill' + (max && fresh(b) >= max ? ' bad' : max && fresh(b) >= max * blockWarn ? ' warn' : ''), style: 'width:' + (max && fresh(b) != null ? Math.min(100, fresh(b) / max * 100) : 0).toFixed(1) + '%' }))),
      h('td', { class: 'num' }, String(b.calls)),
      showCost ? h('td', { class: 'num' }, money(b.cost)) : null,
    ]);
    if (blocks.current) rows.push(mk(blocks.current, true));
    for (const b of rowsData) rows.push(mk(b, false));
    if (!rows.length) { w.append(h('p', { class: 'muted' }, 'Sin bloques todavía.')); return w; }
    w.append(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', {}, 'Inicio'),
        h('th', { title: 'Entrada nueva + salida + escritura en caché (sin la caché leída)' }, 'Sin caché'),
        h('th', { title: 'Incluye las relecturas de caché' }, 'Total'),
        h('th', { title: 'Tokens sin caché respecto a tu bloque más grande' }, 'Respecto a tu máximo'), h('th', {}, 'Llamadas'), showCost ? h('th', {}, 'Coste') : null])),
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
    else if (m.type === 'history') { hist = m.data; statusEl.textContent = m.scanning ? 'Leyendo sesiones…' : ''; if (tab === 'hist') render(); }
    else if (m.type === 'progress') statusEl.textContent = 'Leyendo sesiones… ' + m.i + '/' + m.n;
    else if (m.type === 'blocks') { blocks = m; if (tab === 'hist' && !detail) render(); }
    else if (m.type === 'detail') { detail = m.data; tab = 'hist'; render(); }
  });
  vscode.postMessage({ type: 'ready' });
  render();
})();
