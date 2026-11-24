(function () {
  'use strict';
  // Vista compacta: recibe un único mensaje 'state' con todo lo necesario y repinta.
  // Cada dato lleva un `title` que explica qué es al pasar el ratón por encima.
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

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

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      // VS Code no muestra los tooltips nativos (title) en las vistas: usamos un bocadillo propio
      else if (k === 'title') el.dataset.tip = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      // La CSP de VS Code bloquea setAttribute('style'); el CSSOM (el.style) sí está permitido
      else if (k === 'style') for (const d of String(v).split(';')) { const i = d.indexOf(':'); if (i > 0) el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); }
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
  const num = (n) => Math.round(n || 0).toLocaleString(LOCALE);
  const money = (x) => '$' + (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
  const hm = (ms) => new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const day = (ms) => new Date(ms).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
  const dur = (mins) => { const hh = Math.floor(mins / 60), mm = Math.round(mins % 60); return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`; };
  const pctOf = (a, b) => b ? a / b * 100 : 0;
  const pctTxt = (p) => p.toFixed(p < 10 ? 1 : 0) + '%';
  const level = (v, warn, bad) => v >= bad ? 'bad' : v >= warn ? 'warn' : '';

  // Filas "etiqueta … valor" con la explicación en las dos celdas
  const rows = (list) => h('div', { class: 'grid' }, list.filter(Boolean).flatMap(([k, v, tip]) => [
    h('span', { class: 'muted' + (tip ? ' tip' : ''), title: tip }, k),
    h('span', { class: 'v', title: tip }, v),
  ]));

  // Reparte `n` cuadrados entre las partes, proporcionalmente (mayor resto).
  // El total de cuadrados siempre es el % real redondeado: nunca se infla el dibujo.
  function squares(parts, capacity, n) {
    const exact = parts.map(p => capacity ? p.value / capacity * n : 0);
    const out = exact.map(Math.floor);
    let left = Math.min(n, Math.round(exact.reduce((a, b) => a + b, 0))) - out.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) { if (left <= 0) break; out[i]++; left--; }
    // Una parte que llega a 1/5 de cuadrado pero se quedó sin ninguno se lo quita a la mayor
    exact.forEach((x, i) => {
      if (out[i] > 0 || x < 0.2) return;
      const big = out.indexOf(Math.max(...out));
      if (out[big] > 1) { out[big]--; out[i] = 1; }
    });
    return out;
  }

  // Esquema de 100 cuadraditos: cada uno es el 1 % de `capacity`
  function waffle(parts, capacity, title) {
    const N = 100;
    const counts = squares(parts, capacity, N);
    const cells = [];
    parts.forEach((p, i) => { for (let k = 0; k < counts[i] && cells.length < N; k++) cells.push(h('i', { class: 'sq ' + p.cls })); });
    while (cells.length < N) cells.push(h('i', { class: 'sq free' }));
    return h('div', { class: 'waffle', title, role: 'img', 'aria-label': title }, cells);
  }

  const legend = (items) => h('div', { class: 'legend' }, items.filter(Boolean).map(([cls, label, tip]) =>
    h('span', { title: tip }, [h('i', { class: 'sq ' + cls }), label])));

  function contextSection(s, cfg) {
    const u = s.lastCallUsage;
    const pct = pctOf(s.currentContext, s.contextWindow);
    const cls = level(pct, cfg.warningPercent, cfg.errorPercent);
    const per = s.contextWindow / 100;
    const ctxTip = t('This session carries {0} tokens of context: that is what Claude reads again on every call (instructions, files read and the whole conversation). It fills {1} of the {2} window. When it fills up, Claude Code compacts the conversation (or you can do it with /compact).',
      num(s.currentContext), pctTxt(pct), fmt(s.contextWindow));
    const waffleTip = t('Each square is 1% of the window ({0} tokens). {1} come from cache, {2} were just written to cache and {3} are new input. {4} left free.',
      fmt(per), fmt(u.cacheRead), fmt(u.cw5m + u.cw1h), fmt(u.input), fmt(Math.max(0, s.contextWindow - s.currentContext)));
    return h('section', {}, [
      h('h4', {}, [t('Context'), h('span', { class: 'right', title: t('The highest context this session has reached.') }, t('peak {0}', fmt(s.peakContext)))]),
      h('div', { title: ctxTip }, [
        h('span', { class: 'pct ' + cls }, pctTxt(pct)),
        h('span', { class: 'big' }, [fmt(s.currentContext), h('span', { class: 'of' }, ' / ' + fmt(s.contextWindow))]),
      ]),
      waffle([
        { value: u.cacheRead, cls: 'c-read' },
        { value: u.cw5m + u.cw1h, cls: 'c-write' },
        { value: u.input, cls: 'c-input' },
      ], s.contextWindow, waffleTip),
      legend([
        ['c-read', t('from cache'), t('Context that was already cached and was read again: fast and cheap (10% of the input price).')],
        ['c-write', t('new in cache'), t('New context (your message, tool results…) written to cache for the next calls.')],
        ['c-input', t('uncached'), t('Input that does not go through the cache.')],
        ['free', t('free'), t('Space left in the context window.')],
      ]),
      h('div', { class: 'muted small', title: t('How many tokens fit in this model\'s context, and why.') }, t('{0} window: {1}', fmt(s.contextWindow), t(s.contextWindowReason))),
    ]);
  }

  function lastCallSection(s) {
    const u = s.lastCallUsage;
    return h('section', {}, [
      h('h4', { title: t('Claude Code\'s most recent call to the model. Its input (cache read + cache write + new input) is the current context.') }, t('Last call')),
      rows([
        [t('Read from cache'), fmt(u.cacheRead), t('Context Claude already had in cache and read again. It is the largest part, but costs 10% of normal input.')],
        [t('Written to cache'), fmt(u.cw5m + u.cw1h), t('New context in this call, written to cache to reuse in the next ones.')],
        [t('New input'), fmt(u.input), t('Tokens sent without going through the cache.')],
        [t('Output'), fmt(u.output), t('What Claude wrote in this call: text, code and tool calls. It will be part of the next call\'s context.')],
      ]),
    ]);
  }

  function sessionSection(s, cfg) {
    const tt = s.totals || { cacheRead: 0, cw5m: 0, cw1h: 0, input: 0, output: 0 };
    const total = s.totalTokens || 1;
    const seg = (value, cls, tip) => value > 0 ? h('i', { class: 'seg ' + cls, title: tip, style: 'width:' + (value / total * 100).toFixed(2) + '%' }) : null;
    const rereadPct = pctOf(tt.cacheRead, s.totalTokens);
    const fixed = s.firstCallUsage ? s.firstCallUsage.cacheRead : 0;
    const cacheTip = t('On every call, Claude Code resends the whole context: its instructions, the tools, your CLAUDE.md files and the entire conversation. What was already cached is read from there, which is faster and costs 10% of normal input.')
      + (fixed > 0 ? ' ' + t('It happens even in a new chat: its first call already read {0} tokens from cache (Claude Code\'s instructions and tools, which your other chats had left in cache).', fmt(fixed)) : '')
      + ' ' + t('That is why the more calls a chat makes, the more cache reads weigh in the total.');
    return h('section', {}, [
      h('h4', {}, t('Session')),
      h('div', { class: 'stack', role: 'img', 'aria-label': t('Breakdown of processed tokens') }, [
        seg(tt.cacheRead, 'c-read', t('Cache reads: {0} ({1}). Every call reads the context again, which is why it is the largest part.', fmt(tt.cacheRead), pctTxt(rereadPct))),
        seg(tt.cw5m + tt.cw1h, 'c-write', t('Written to cache: {0}.', fmt(tt.cw5m + tt.cw1h))),
        seg(tt.input, 'c-input', t('Uncached input: {0}.', fmt(tt.input))),
        seg(tt.output, 'c-output', t('Claude\'s output: {0}.', fmt(tt.output))),
      ]),
      h('div', { class: 'muted small tip', title: cacheTip },
        t('{0} of what was processed was read from cache (context resent on every call)', pctTxt(rereadPct))),
      rows([
        [t('Prompts'), String(s.prompts), t('Messages you have written in this session (not counting tool results).')],
        [t('API calls'), String(s.apiCalls), t('Times Claude Code has called the model. One prompt usually makes several: one per step or tool.')],
        [t('Tokens processed'), fmt(s.totalTokens), t('Sum of all calls, counting every re-read of the context. That is why it grows much faster than the context.')],
        [t('Without cache reads'), fmt(s.freshTokens), t('What was processed without counting cache reads: new input, output and cache writes.')],
        s.subTokens > 0 ? [t('Subagents'), fmt(s.subTokens), t('Tokens from the subagents Claude has launched (included in the total). They have their own context and do not take up yours.')] : null,
        cfg.showCost ? [t('API-equivalent cost'), money(s.cost), t('What this session would cost paying for the API at list price. With Pro or Max it is not what you pay.')] : null,
      ]),
    ]);
  }

  function promptSection(p, cfg) {
    if (!p) return null;
    const added = p.startCtx == null ? null : p.endCtx - p.startCtx;
    return h('section', {}, [
      h('h4', {}, [t('Last prompt'), p.ts ? h('span', { class: 'right', title: t('When you wrote it.') }, hm(p.ts)) : null]),
      h('div', { class: 'q', title: tp(p.text) }, tp(p.text)),
      rows([
        [t('Context'), (p.startCtx == null ? '—' : fmt(p.startCtx)) + ' → ' + fmt(p.endCtx),
          t('Context when the answer started → when it finished.') + (added != null ? ' ' + t('This prompt added {0} tokens to the context.', fmt(Math.max(0, added))) : '')],
        [t('Calls'), String(p.calls) + (p.subCalls ? ' + ' + t('{0} subag.', p.subCalls) : ''), t('Calls to the model to answer this prompt (plus subagent calls, if any).')],
        [t('Tokens'), fmt(p.tokens), t('Everything processed to answer this prompt, counting the cache reads of every call.')],
        cfg.showCost ? [t('Cost'), money(p.cost), t('What this answer would have cost through the API at list price.')] : null,
      ]),
    ]);
  }

  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 1 ? t('just now') : t('{0} ago', m < 60 ? `${m} min` : dur(m));
  };
  const dayTime = (ms) => new Date(ms).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const UPDATE_TIP = t('Claude Code saves this data when it checks your usage with Anthropic (for example when you type /usage). The extension only reads it: it does not connect to anything.');

  // Límite oficial de 5 h y semanal (de ~/.claude.json)
  function officialSection(st) {
    const off = st.official, b = st.block, cfg = st.cfg;
    if (!off || (!off.five && !off.expiredAt && !off.week)) return null;
    const sec = h('section', {});
    if (off.five) {
      const pct = off.five.pct;
      const cls = pct >= 95 ? 'bad' : pct >= cfg.blockWarnRatio * 100 ? 'warn' : '';
      const mins = (off.five.resetsAt - Date.now()) / 60000;
      sec.append(
        h('h4', { title: t('Your 5-hour usage limit, according to Anthropic. It counts everything: Claude Code, claude.ai, Cowork and other computers.') },
          [t('5-hour limit'), h('span', { class: 'right', title: t('The window ends at {0}; then the % goes back to 0.', hm(off.five.resetsAt)) }, t('resets {0}', hm(off.five.resetsAt)))]),
        h('div', { title: t('You have used {0}% of your 5-hour limit. {1} left until it resets (at {2}).', pct, dur(mins), hm(off.five.resetsAt)) }, [
          h('span', { class: 'pct ' + cls }, t('in {0}', dur(mins))),
          h('span', { class: 'big' }, [pct + '%', h('span', { class: 'of' }, ' ' + t('used · official'))]),
        ]),
        waffle([{ value: pct, cls: 'b-used' + (cls ? ' ' + cls : '') }], 100,
          t('Each square is 1% of your 5-hour limit. You are at {0} of 100.', pct)),
      );
    } else if (off.expiredAt) {
      const next = b && b.alignedToOfficial ? b.end : null;
      sec.append(
        h('h4', { title: t('Your 5-hour usage limit, according to Anthropic.') },
          [t('5-hour limit'), next ? h('span', { class: 'right', title: t('Calculated by chaining 5-hour windows from the last official reset.') }, t('resets ~{0}', hm(next))) : null]),
        h('div', { class: 'muted', title: UPDATE_TIP },
          t('It reset at {0}.', hm(off.expiredAt)) + ' ' + (next ? t('The current window ends around {0}.', hm(next)) : t('The next one starts with your next message.'))
          + ' ' + t('The new % will appear when Claude Code checks it again (for example with /usage).')),
      );
    }
    if (off.week) {
      const wcls = off.week.pct >= 95 ? 'bad' : off.week.pct >= cfg.blockWarnRatio * 100 ? 'warn' : '';
      const parts = (off.breakdown || []).map(r => `${r.name}: ${r.percent}%`).join(', ');
      sec.append(
        h('div', { class: 'weekrow', title: t('You are at {0}% of your weekly limit. It resets {1}.', off.week.pct, dayTime(off.week.resetsAt))
          + (parts ? ' ' + t('Breakdown of this week\'s usage: {0}.', parts) : '') }, [
          h('span', { class: 'muted' }, t('Weekly')),
          h('span', { class: 'bar' }, h('i', { class: 'fill ' + wcls, style: 'width:' + Math.min(100, off.week.pct) + '%' })),
          h('span', { class: 'v' }, off.week.pct + '%'),
        ]),
        h('div', { class: 'muted small' }, t('resets {0}', dayTime(off.week.resetsAt))
          + (off.breakdown && off.breakdown.length ? ' · ' + off.breakdown.map(r => `${r.name} ${r.percent}%`).join(' · ') : '')),
      );
    }
    if (off.fetchedAt) sec.append(h('div', { class: 'note muted', title: UPDATE_TIP }, t('Official data from {0}', ago(off.fetchedAt))));
    return sec;
  }

  // Claude Code en este ordenador durante la ventana actual: primero el proyecto abierto,
  // después todos los proyectos (lo que cuenta para el límite) con su reparto.
  function blockSection(st) {
    const b = st.block, max = st.max, cfg = st.cfg;
    if (!cfg.showBlock) return null;
    const hasOfficialPct = !!(st.official && st.official.five);
    const aligned = hasOfficialPct || (b && b.alignedToOfficial);
    const sec = h('section', {}, [h('h4', {
      title: aligned
        ? t('The current 5-hour window of the official limit. Only Claude Code on this computer shows here (not claude.ai, Cowork or other computers).')
        : t('Without official data, the window is estimated from Claude Code on this computer: it starts with your first message and lasts 5 hours.'),
    }, [aligned ? t('Current window') : t('5-hour block (estimated)'), b ? h('span', { class: 'right', title: t('Start and end of the window.') }, hm(b.start) + ' → ' + hm(b.end)) : null])]);
    if (!b) {
      sec.append(h('div', { class: 'muted' }, t('No Claude Code activity on this computer in the current window.')));
      return sec;
    }

    // 1) Este proyecto
    const cur = b.currentProject;
    const curName = tp((st.live && st.live.project) || ((b.projects || []).find(p => p.current) || {}).name || t('This project'));
    if (cur) {
      sec.append(
        h('div', { class: 'sub', title: t('What Claude Code has used in {0} (all its chats and subagents) within the current window.', curName) }, [
          h('span', { class: 'muted' }, t('This project') + ' · '), curName,
        ]),
        h('div', { title: t('{0}: {1} tokens without counting cache reads ({2} counting them) in this window.', curName, num(cur.freshTokens), fmt(cur.tokens)) }, [
          h('span', { class: 'big' }, [fmt(cur.freshTokens), h('span', { class: 'of' }, ' ' + t('uncached · {0} total', fmt(cur.tokens)))]),
        ]),
        rows([
          [t('Rate (30 min)'), cur.perMinFresh > 0 ? fmt(cur.perMinFresh) + '/min' : t('idle'), t('Tokens per minute (without cache reads) for this project in the last 30 minutes.')],
          [t('Calls'), String(cur.calls), t('Calls to the model from this project in this window.')],
          cfg.showCost ? [t('API-equivalent cost'), money(cur.cost), t('What it would cost through the API at list price. With Pro or Max it is not what you pay.')] : null,
        ]),
      );
    }

    // 2) Todos los proyectos de este ordenador
    const ratio = max && max.freshTokens ? b.freshTokens / max.freshTokens : 0;
    const cls = ratio >= 1 ? 'bad' : ratio >= cfg.blockWarnRatio ? 'warn' : '';
    const others = (b.projects || []).filter(p => !p.current && p.recentFresh > 0).map(p => p.name);
    const allTip = t('The 5-hour limit counts everything you use, across all your projects (and also claude.ai and Cowork).')
      + ' ' + t('In this window, Claude Code on this computer is at {0} tokens without cache reads ({1} counting them).', num(b.freshTokens), fmt(b.tokens))
      + (others.length ? ' ' + t('Right now it is working on: {0}; that is why this total goes up even if you do nothing here.', others.map(tp).join(', ')) : '')
      + (max ? ' ' + t('It is {0}% of your largest block.', Math.round(ratio * 100)) : '');
    sec.append(
      h('div', { class: 'sub', title: allTip }, [h('span', { class: 'muted' }, t('All your projects') + ' · '), t('this computer')]),
      h('div', { title: allTip }, [
        max ? h('span', { class: 'pct ' + cls, title: t('Compared with your largest 5-hour block on this computer.') }, t('{0}% of your max', Math.round(ratio * 100))) : null,
        h('span', { class: 'big' }, [fmt(b.freshTokens), h('span', { class: 'of' }, ' ' + t('uncached · {0} total', fmt(b.tokens)))]),
      ]),
    );
    const list = b.projects || [];
    if (list.length) {
      const top = list[0].freshTokens || 1;
      sec.append(h('div', { class: 'projlist' }, list.map(p => h('div', {
        class: 'projrow' + (p.current ? ' current' : ''),
        title: t('{0}: {1} uncached tokens ({2} with cache), {3} calls in this window.', tp(p.name), num(p.freshTokens), fmt(p.tokens), p.calls)
          + ' ' + (p.recentFresh > 0 ? t('It has been active in the last 30 minutes.') : t('No activity in the last 30 minutes.'))
          + (p.current ? ' ' + t('It is the open project.') : ''),
      }, [
        h('span', { class: 'pname' }, [p.recentFresh > 0 ? h('i', { class: 'live' }) : null, tp(p.name)]),
        h('span', { class: 'pbar' }, h('i', { class: 'fill', style: 'width:' + Math.max(2, p.freshTokens / top * 100).toFixed(1) + '%' })),
        h('span', { class: 'v' }, fmt(p.freshTokens)),
      ]))));
      if (b.otherProjects) sec.append(h('div', { class: 'muted small' }, b.otherProjects === 1 ? t('and 1 more project') : t('and {0} more projects', b.otherProjects)));
    }
    // Sin % oficial, los cuadraditos comparan el total con tu bloque más grande
    if (max && !hasOfficialPct) {
      const proj = Math.max(0, Math.min(b.projectedFresh, max.freshTokens) - b.freshTokens);
      sec.append(
        waffle([
          { value: Math.min(b.freshTokens, max.freshTokens), cls: 'b-used' + (cls ? ' ' + cls : '') },
          { value: proj, cls: 'b-proj' },
        ], max.freshTokens,
        t('Each square is 1% of your largest block ({0} uncached tokens). Filled: what you have used. Outlined: what you would reach by the end of the block at the same rate. Dimmed: what is left up to your max.', fmt(max.freshTokens / 100))
          + (ratio >= 1 ? ' ' + t('You have already gone over your max.') : '')),
        legend([
          ['b-used', t('used'), t('What you have used in this block (without cache reads), all projects.')],
          ['b-proj', t('forecast'), t('What you would add before it resets if you keep the rate of the last 30 minutes.')],
          ['free', t('up to your max'), t('What is left to match your largest block.')],
        ]),
      );
    }
    sec.append(rows([
      hasOfficialPct ? null : [t('Resets in'), dur(b.minsLeft), t('The window ends at {0}.', hm(b.end)) + ' ' + (b.alignedToOfficial ? t('Calculated from the last official reset.') : t('Estimated.'))],
      max ? [t('Your largest block'), fmt(max.freshTokens) + ' (' + day(max.start) + ')', t('The 5-hour window in which Claude Code used the most on this computer (without cache reads, all projects).')] : null,
      [t('Total rate (30 min)'), fmt(b.perMinFresh) + '/min', t('Tokens per minute (without cache reads) across all your projects in the last 30 minutes.')],
      [t('At this rate'), fmt(b.projectedFresh), t('What all projects together would reach by the end of the window if the current rate holds.')],
      [t('Calls'), String(b.calls), t('Calls to the model in this window, across all your projects.')],
      cfg.showCost ? [t('API-equivalent cost'), money(b.cost), t('What it would cost through the API at list price, all projects. With Pro or Max it is not what you pay.')] : null,
    ]));
    if (!hasOfficialPct && max && b.projectedFresh > max.freshTokens && ratio < 1) {
      sec.append(h('div', { class: 'warnline' }, '⚠ ' + t('At this rate you will go over your largest block before it resets.')));
    }
    if (!max) sec.append(h('div', { class: 'note muted' }, st.scanDone ? t('There are no previous blocks to compare with yet.') : t('Calculating your previous blocks…')));
    return sec;
  }

  function render(st) {
    const kids = [];
    const s = st.live;
    if (s) {
      kids.push(h('div', { class: 'head' }, [
        h('span', { class: 'proj', title: t('Project of the Claude Code session being measured.') }, tp(s.project)),
        h('span', { class: 'model muted', title: t('Model of the last response.') }, s.model),
      ]));
      // Qué chat se está midiendo: un chat nuevo no aparece hasta su primer mensaje
      const when = s.firstTs ? day(Date.parse(s.firstTs)) + ' ' + hm(Date.parse(s.firstTs)) : '';
      kids.push(h('div', { class: 'chat muted small', title: t('The most recent chat in this folder is being measured: “{0}”.', tp(s.title))
        + ' ' + t('A new chat appears here as soon as you send its first message; until then Claude Code does not create its file and the previous one is still shown.') },
        t('Chat from {0}', when) + ' · ' + (s.prompts === 1 ? t('1 prompt') : t('{0} prompts', s.prompts))));
      kids.push(contextSection(s, st.cfg), lastCallSection(s), sessionSection(s, st.cfg), promptSection(s.lastPrompt, st.cfg));
    } else {
      kids.push(h('div', { class: 'empty' }, t('There is no Claude Code session in this folder yet. It will show up here as soon as you write to Claude.')));
    }
    kids.push(officialSection(st), blockSection(st));
    kids.push(h('button', { onclick: () => vscode.postMessage({ type: 'openPanel' }), title: t('Session history, chart per prompt and previous blocks.') }, t('Open full panel')));
    app.replaceChildren(...kids.filter(Boolean));
  }

  // ── Bocadillo explicativo ──
  // Un solo elemento flotante; aparece al pasar el ratón por cualquier cosa con data-tip.
  const bubble = h('div', { class: 'bubble', role: 'tooltip', 'aria-hidden': 'true' });
  document.body.append(bubble);
  let tipTarget = null, tipTimer = null;

  function showTip(el) {
    bubble.textContent = el.dataset.tip;
    bubble.classList.add('on');
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const mx = Math.min(Math.max(r.left + Math.min(r.width, 160) / 2, 8), vw - 8); // hacia donde apunta la flecha
    const left = Math.min(Math.max(mx - bw / 2, 6), vw - bw - 6);
    const below = r.bottom + 8 + bh <= vh || r.top - 8 - bh < 0;
    bubble.classList.toggle('above', !below);
    bubble.style.setProperty('left', left + 'px');
    bubble.style.setProperty('top', (below ? r.bottom + 8 : r.top - 8 - bh) + 'px');
    bubble.style.setProperty('--ax', (mx - left) + 'px');
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipTarget = null;
    bubble.classList.remove('on');
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el === tipTarget) return;
    hideTip();
    if (!el) return;
    tipTarget = el;
    tipTimer = setTimeout(() => { if (tipTarget === el && el.isConnected) showTip(el); }, 250);
  });
  document.addEventListener('mouseleave', hideTip);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);

  window.addEventListener('message', (ev) => {
    if (!(ev.data && ev.data.type === 'state')) return;
    // Si el bocadillo estaba abierto, se mantiene sobre el mismo dato tras repintar
    // (por posición: el texto puede cambiar, p. ej. los minutos que faltan)
    const open = tipTarget && bubble.classList.contains('on');
    const idx = open ? [...document.querySelectorAll('[data-tip]')].indexOf(tipTarget) : -1;
    render(ev.data);
    if (open) {
      const again = document.querySelectorAll('[data-tip]')[idx];
      if (again) { tipTarget = again; showTip(again); } else hideTip();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
