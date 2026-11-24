(function () {
  'use strict';
  // Vista compacta: recibe un único mensaje 'state' con todo lo necesario y repinta.
  // Cada dato lleva un `title` que explica qué es al pasar el ratón por encima.
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
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
  const num = (n) => Math.round(n || 0).toLocaleString('es-ES');
  const money = (x) => '$' + (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
  const hm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const day = (ms) => new Date(ms).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
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
    const ctxTip = `Esta sesión arrastra ${num(s.currentContext)} tokens de contexto: es lo que Claude vuelve a leer en cada llamada `
      + `(instrucciones, archivos leídos y toda la conversación). Ocupa el ${pctTxt(pct)} de la ventana de ${fmt(s.contextWindow)}. `
      + `Cuando se llena, Claude Code compacta la conversación (o puedes hacerlo tú con /compact).`;
    const waffleTip = `Cada cuadrado es el 1 % de la ventana (${fmt(per)} tokens). `
      + `${fmt(u.cacheRead)} vienen de caché, ${fmt(u.cw5m + u.cw1h)} se acaban de guardar en caché y ${fmt(u.input)} son entrada nueva. `
      + `Quedan ${fmt(Math.max(0, s.contextWindow - s.currentContext))} libres.`;
    return h('section', {}, [
      h('h4', {}, ['Contexto', h('span', { class: 'right', title: 'El contexto más alto que ha llegado a tener esta sesión.' }, 'pico ' + fmt(s.peakContext))]),
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
        ['c-read', 'de caché', 'Contexto que ya estaba guardado en caché y se ha releído: rápido y barato (10 % del precio de entrada).'],
        ['c-write', 'nuevo en caché', 'Contexto nuevo (tu mensaje, resultados de herramientas…) que se ha guardado en caché para las siguientes llamadas.'],
        ['c-input', 'sin caché', 'Entrada que no pasa por la caché.'],
        ['free', 'libre', 'Espacio que queda en la ventana de contexto.'],
      ]),
      h('div', { class: 'muted small', title: 'Cuántos tokens caben en el contexto de este modelo y por qué.' }, 'Ventana ' + fmt(s.contextWindow) + ': ' + s.contextWindowReason),
    ]);
  }

  function lastCallSection(s) {
    const u = s.lastCallUsage;
    return h('section', {}, [
      h('h4', { title: 'La llamada más reciente de Claude Code al modelo. Su entrada (caché leída + escrita + entrada nueva) es el contexto actual.' }, 'Última llamada'),
      rows([
        ['Leídos de caché', fmt(u.cacheRead), 'Contexto que Claude ya tenía en caché y ha vuelto a leer. Es lo que más pesa, pero cuesta un 10 % de la entrada normal.'],
        ['Escritos en caché', fmt(u.cw5m + u.cw1h), 'Contexto nuevo en esta llamada que se guarda en caché para reutilizarlo en las siguientes.'],
        ['Entrada nueva', fmt(u.input), 'Tokens enviados sin pasar por la caché.'],
        ['Salida', fmt(u.output), 'Lo que Claude ha escrito en esta llamada: texto, código y llamadas a herramientas. Entrará en el contexto de la siguiente.'],
      ]),
    ]);
  }

  function sessionSection(s, cfg) {
    const t = s.totals || { cacheRead: 0, cw5m: 0, cw1h: 0, input: 0, output: 0 };
    const total = s.totalTokens || 1;
    const seg = (value, cls, tip) => value > 0 ? h('i', { class: 'seg ' + cls, title: tip, style: 'width:' + (value / total * 100).toFixed(2) + '%' }) : null;
    const rereadPct = pctOf(t.cacheRead, s.totalTokens);
    return h('section', {}, [
      h('h4', {}, 'Sesión'),
      h('div', { class: 'stack', role: 'img', 'aria-label': 'Composición de los tokens procesados' }, [
        seg(t.cacheRead, 'c-read', `Relecturas de caché: ${fmt(t.cacheRead)} (${pctTxt(rereadPct)}). Cada llamada vuelve a leer el contexto, por eso es la mayor parte.`),
        seg(t.cw5m + t.cw1h, 'c-write', `Escrito en caché: ${fmt(t.cw5m + t.cw1h)}.`),
        seg(t.input, 'c-input', `Entrada sin caché: ${fmt(t.input)}.`),
        seg(t.output, 'c-output', `Salida de Claude: ${fmt(t.output)}.`),
      ]),
      h('div', { class: 'muted small', title: 'Por qué los tokens procesados son tantos más que el contexto.' },
        `${pctTxt(rereadPct)} de lo procesado son relecturas de caché`),
      rows([
        ['Preguntas', String(s.prompts), 'Mensajes que has escrito tú en esta sesión (sin contar los resultados de herramientas).'],
        ['Llamadas a la API', String(s.apiCalls), 'Veces que Claude Code ha llamado al modelo. Una pregunta suele generar varias: una por cada paso o herramienta.'],
        ['Tokens procesados', fmt(s.totalTokens), 'Suma de todas las llamadas, contando cada relectura del contexto. Por eso crece mucho más deprisa que el contexto.'],
        ['Sin caché leída', fmt(s.freshTokens), 'Lo procesado sin contar las relecturas de caché: entrada nueva, salida y escritura en caché.'],
        s.subTokens > 0 ? ['Subagentes', fmt(s.subTokens), 'Tokens de los subagentes que ha lanzado Claude (incluidos en el total). Tienen su propio contexto, no ocupan el tuyo.'] : null,
        cfg.showCost ? ['Coste equiv. API', money(s.cost), 'Lo que costaría esta sesión pagando la API a precio público. Con Pro o Max no es lo que pagas.'] : null,
      ]),
    ]);
  }

  function promptSection(p, cfg) {
    if (!p) return null;
    const added = p.startCtx == null ? null : p.endCtx - p.startCtx;
    return h('section', {}, [
      h('h4', {}, ['Última pregunta', p.ts ? h('span', { class: 'right', title: 'Hora a la que la escribiste.' }, hm(p.ts)) : null]),
      h('div', { class: 'q', title: p.text }, p.text),
      rows([
        ['Contexto', (p.startCtx == null ? '—' : fmt(p.startCtx)) + ' → ' + fmt(p.endCtx),
          'Contexto al empezar a responder → al terminar.' + (added != null ? ` Esta pregunta ha añadido ${fmt(Math.max(0, added))} tokens al contexto.` : '')],
        ['Llamadas', String(p.calls) + (p.subCalls ? ' + ' + p.subCalls + ' subag.' : ''), 'Llamadas al modelo para responder a esta pregunta (más las de subagentes, si los hubo).'],
        ['Tokens', fmt(p.tokens), 'Todo lo procesado para responder a esta pregunta, contando las relecturas de caché de cada llamada.'],
        cfg.showCost ? ['Coste', money(p.cost), 'Lo que habría costado esta respuesta por la API a precio público.'] : null,
      ]),
    ]);
  }

  function blockSection(st) {
    const b = st.block, max = st.max, cfg = st.cfg;
    if (!cfg.showBlock) return null;
    const sec = h('section', {}, [h('h4', { title: 'Claude limita el uso por bloques de 5 horas. Aquí se estima el bloque actual con todo Claude Code de este ordenador.' },
      ['Bloque de 5 h', b ? h('span', { class: 'right', title: 'Inicio y fin del bloque actual.' }, hm(b.start) + ' → ' + hm(b.end)) : null])]);
    if (!b) {
      sec.append(h('div', { class: 'muted' }, 'Sin actividad en las últimas 5 horas: el próximo mensaje abrirá un bloque nuevo.'));
      return sec;
    }
    const ratio = max && max.freshTokens ? b.freshTokens / max.freshTokens : 0;
    const cls = ratio >= 1 ? 'bad' : ratio >= cfg.blockWarnRatio ? 'warn' : '';
    const bigTip = `En este bloque llevas ${num(b.freshTokens)} tokens sin contar las relecturas de caché `
      + `(${fmt(b.tokens)} contándolas), sumando todos tus proyectos y subagentes.`
      + (max ? ` Es el ${Math.round(ratio * 100)} % de tu bloque más grande.` : '');
    sec.append(h('div', { title: bigTip }, [
      max ? h('span', { class: 'pct ' + cls }, Math.round(ratio * 100) + '%') : null,
      h('span', { class: 'big' }, [fmt(b.freshTokens), h('span', { class: 'of' }, ' sin caché · ' + fmt(b.tokens) + ' total')]),
    ]));
    if (max) {
      const proj = Math.max(0, Math.min(b.projectedFresh, max.freshTokens) - b.freshTokens);
      sec.append(
        waffle([
          { value: Math.min(b.freshTokens, max.freshTokens), cls: 'b-used' + (cls ? ' ' + cls : '') },
          { value: proj, cls: 'b-proj' },
        ], max.freshTokens,
        `Cada cuadrado es el 1 % de tu bloque más grande (${fmt(max.freshTokens / 100)} tokens sin caché). `
          + `Llenos: lo que llevas. Tenues: lo que llevarías al acabar el bloque si sigues al mismo ritmo.`
          + (ratio >= 1 ? ' Ya has superado tu máximo.' : '')),
        legend([
          ['b-used', 'usado', 'Lo que llevas en este bloque (sin caché leída).'],
          ['b-proj', 'previsión', 'Lo que añadirías hasta que se reinicie si mantienes el ritmo de los últimos 30 minutos.'],
          ['free', 'hasta tu máximo', 'Lo que falta para igualar tu bloque más grande.'],
        ]),
      );
    }
    sec.append(rows([
      ['Se reinicia en', dur(b.minsLeft), `El bloque termina a las ${hm(b.end)}. Después, el siguiente mensaje abre uno nuevo.`],
      max ? ['Tu bloque más grande', fmt(max.freshTokens) + ' (' + day(max.start) + ')', 'El bloque de 5 h en el que más has gastado (sin caché leída). Sirve de referencia para el %.'] : null,
      ['Ritmo (30 min)', fmt(b.perMinFresh) + '/min', 'Media de tokens por minuto (sin caché leída) en los últimos 30 minutos.'],
      ['Si sigues así', fmt(b.projectedFresh), 'Lo que llevarías al terminar el bloque si mantienes el ritmo actual.'],
      ['Llamadas', String(b.calls), 'Llamadas al modelo en este bloque, de todos tus proyectos.'],
      cfg.showCost ? ['Coste equiv. API', money(b.cost), 'Lo que costaría este bloque por la API a precio público. Con Pro o Max no es lo que pagas.'] : null,
    ]));
    if (max && b.projectedFresh > max.freshTokens && ratio < 1) {
      sec.append(h('div', { class: 'warnline' }, '⚠ A este ritmo superarás tu bloque más grande antes de que se reinicie.'));
    }
    if (!max) sec.append(h('div', { class: 'note muted' }, st.scanDone ? 'Aún no hay bloques anteriores para comparar.' : 'Calculando tus bloques anteriores…'));
    sec.append(h('div', { class: 'note muted' }, 'Estimación local con todo Claude Code de este ordenador; no es el % oficial de tu plan.'));
    return sec;
  }

  function render(st) {
    const kids = [];
    const s = st.live;
    if (s) {
      kids.push(h('div', { class: 'head' }, [
        h('span', { class: 'proj', title: 'Proyecto de la sesión de Claude Code que se está midiendo.' }, s.project),
        h('span', { class: 'model muted', title: 'Modelo de la última respuesta.' }, s.model),
      ]));
      kids.push(contextSection(s, st.cfg), lastCallSection(s), sessionSection(s, st.cfg), promptSection(s.lastPrompt, st.cfg));
    } else {
      kids.push(h('div', { class: 'empty' }, 'No hay ninguna sesión de Claude Code en esta carpeta todavía. En cuanto escribas a Claude aparecerá aquí.'));
    }
    kids.push(blockSection(st));
    kids.push(h('button', { onclick: () => vscode.postMessage({ type: 'openPanel' }), title: 'Histórico de sesiones, gráfico por pregunta y bloques anteriores.' }, 'Abrir panel completo'));
    app.replaceChildren(...kids.filter(Boolean));
  }

  window.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'state') render(ev.data); });
  vscode.postMessage({ type: 'ready' });
})();
