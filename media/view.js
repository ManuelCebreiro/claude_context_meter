(function () {
  'use strict';
  // Vista compacta: recibe un único mensaje 'state' con todo lo necesario y repinta.
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

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
  function fmt(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }
  const money = (x) => '$' + (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
  const hm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const day = (ms) => new Date(ms).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  const dur = (mins) => { const hh = Math.floor(mins / 60), mm = Math.round(mins % 60); return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`; };
  const level = (v, warn, bad) => v >= bad ? 'bad' : v >= warn ? 'warn' : '';
  const meter = (pct, cls) => h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('div', { class: 'fill ' + cls, style: 'width:' + Math.min(100, Math.max(0, pct)).toFixed(1) + '%' }));
  const rows = (pairs) => h('div', { class: 'grid' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('span', { class: 'muted' }, k), h('span', { class: 'v' }, v)]));

  function contextSection(s, cfg) {
    const pct = s.contextWindow ? s.currentContext / s.contextWindow * 100 : 0;
    const cls = level(pct, cfg.warningPercent, cfg.errorPercent);
    return h('section', {}, [
      h('h4', {}, ['Contexto', h('span', { class: 'right' }, 'pico ' + fmt(s.peakContext))]),
      h('div', {}, [
        h('span', { class: 'pct ' + cls }, pct.toFixed(pct < 10 ? 1 : 0) + '%'),
        h('span', { class: 'big' }, [fmt(s.currentContext), h('span', { class: 'of' }, ' / ' + fmt(s.contextWindow))]),
      ]),
      meter(pct, cls),
      h('div', { class: 'muted' }, 'Ventana ' + fmt(s.contextWindow) + ': ' + s.contextWindowReason),
    ]);
  }

  function lastCallSection(s) {
    const u = s.lastCallUsage;
    return h('section', {}, [
      h('h4', {}, 'Última llamada'),
      rows([
        ['Leídos de caché', fmt(u.cacheRead)],
        ['Escritos en caché', fmt(u.cw5m + u.cw1h)],
        ['Entrada nueva', fmt(u.input)],
        ['Salida', fmt(u.output)],
      ]),
    ]);
  }

  function sessionSection(s, cfg) {
    return h('section', {}, [
      h('h4', {}, 'Sesión'),
      rows([
        ['Preguntas', String(s.prompts)],
        ['Llamadas a la API', String(s.apiCalls)],
        ['Tokens procesados', fmt(s.totalTokens)],
        ['Sin caché leída', fmt(s.freshTokens)],
        s.subTokens > 0 ? ['Subagentes', fmt(s.subTokens)] : null,
        cfg.showCost ? ['Coste equiv. API', money(s.cost)] : null,
      ]),
    ]);
  }

  function promptSection(p, cfg) {
    if (!p) return null;
    return h('section', {}, [
      h('h4', {}, ['Última pregunta', p.ts ? h('span', { class: 'right' }, hm(p.ts)) : null]),
      h('div', { class: 'q', title: p.text }, p.text),
      rows([
        ['Contexto', (p.startCtx == null ? '—' : fmt(p.startCtx)) + ' → ' + fmt(p.endCtx)],
        ['Llamadas', String(p.calls) + (p.subCalls ? ' + ' + p.subCalls + ' subag.' : '')],
        ['Tokens', fmt(p.tokens)],
        cfg.showCost ? ['Coste', money(p.cost)] : null,
      ]),
    ]);
  }

  function blockSection(st) {
    const b = st.block, max = st.max, cfg = st.cfg;
    if (!cfg.showBlock) return null;
    const sec = h('section', {}, [h('h4', {}, ['Bloque de 5 h', b ? h('span', { class: 'right' }, hm(b.start) + ' → ' + hm(b.end)) : null])]);
    if (!b) {
      sec.append(h('div', { class: 'muted' }, 'Sin actividad en las últimas 5 horas: el próximo mensaje abrirá un bloque nuevo.'));
      return sec;
    }
    const ratio = max && max.freshTokens ? b.freshTokens / max.freshTokens : 0;
    const cls = ratio >= 1 ? 'bad' : ratio >= cfg.blockWarnRatio ? 'warn' : '';
    sec.append(
      h('div', {}, [
        max ? h('span', { class: 'pct ' + cls }, Math.round(ratio * 100) + '%') : null,
        h('span', { class: 'big' }, [fmt(b.freshTokens), h('span', { class: 'of' }, ' sin caché · ' + fmt(b.tokens) + ' total')]),
      ]),
      max ? meter(ratio * 100, cls) : null,
      rows([
        ['Se reinicia en', dur(b.minsLeft)],
        max ? ['Tu bloque más grande', fmt(max.freshTokens) + ' (' + day(max.start) + ')'] : null,
        ['Ritmo (30 min)', fmt(b.perMinFresh) + '/min'],
        ['Si sigues así', fmt(b.projectedFresh)],
        ['Llamadas', String(b.calls)],
        cfg.showCost ? ['Coste equiv. API', money(b.cost)] : null,
      ]),
    );
    if (max && b.projectedFresh > max.freshTokens && ratio < 1) {
      sec.append(h('div', { class: 'warnline' }, '⚠ A este ritmo superarás tu bloque más grande antes de que se reinicie.'));
    }
    if (!max) sec.append(h('div', { class: 'note muted' }, st.scanDone ? 'Aún no hay bloques anteriores para comparar.' : 'Calculando tus bloques anteriores…'));
    sec.append(h('div', { class: 'note muted' }, 'Todo Claude Code de este ordenador, sin contar la caché leída para el %. Estimación local, no el % oficial de tu plan.'));
    return sec;
  }

  function render(st) {
    const kids = [];
    const s = st.live;
    if (s) {
      kids.push(h('div', { class: 'head' }, [
        h('span', { class: 'proj', title: s.project }, s.project),
        h('span', { class: 'model muted' }, s.model),
      ]));
      kids.push(contextSection(s, st.cfg), lastCallSection(s), sessionSection(s, st.cfg), promptSection(s.lastPrompt, st.cfg));
    } else {
      kids.push(h('div', { class: 'empty' }, 'No hay ninguna sesión de Claude Code en esta carpeta todavía. En cuanto escribas a Claude aparecerá aquí.'));
    }
    kids.push(blockSection(st));
    kids.push(h('button', { onclick: () => vscode.postMessage({ type: 'openPanel' }) }, 'Abrir panel completo'));
    app.replaceChildren(...kids.filter(Boolean));
  }

  window.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'state') render(ev.data); });
  vscode.postMessage({ type: 'ready' });
})();
