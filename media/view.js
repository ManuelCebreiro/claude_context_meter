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
    const fixed = s.firstCallUsage ? s.firstCallUsage.cacheRead : 0;
    const cacheTip = `En cada llamada, Claude Code reenvía todo el contexto: sus instrucciones, las herramientas, tus CLAUDE.md y la conversación entera. `
      + `Lo que ya estaba en caché se lee de ahí, que es más rápido y cuesta un 10 % de la entrada normal. `
      + (fixed > 0 ? `Pasa incluso en un chat nuevo: en su primera llamada ya se leyeron ${fmt(fixed)} tokens de caché (las instrucciones y herramientas de Claude Code, que tus otros chats habían dejado en caché). ` : '')
      + `Por eso, cuantas más llamadas hace un chat, más pesa la caché leída en el total.`;
    return h('section', {}, [
      h('h4', {}, 'Sesión'),
      h('div', { class: 'stack', role: 'img', 'aria-label': 'Composición de los tokens procesados' }, [
        seg(t.cacheRead, 'c-read', `Relecturas de caché: ${fmt(t.cacheRead)} (${pctTxt(rereadPct)}). Cada llamada vuelve a leer el contexto, por eso es la mayor parte.`),
        seg(t.cw5m + t.cw1h, 'c-write', `Escrito en caché: ${fmt(t.cw5m + t.cw1h)}.`),
        seg(t.input, 'c-input', `Entrada sin caché: ${fmt(t.input)}.`),
        seg(t.output, 'c-output', `Salida de Claude: ${fmt(t.output)}.`),
      ]),
      h('div', { class: 'muted small tip', title: cacheTip },
        `${pctTxt(rereadPct)} de lo procesado se leyó de caché (contexto reenviado en cada llamada)`),
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

  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 1 ? 'hace un momento' : m < 60 ? `hace ${m} min` : `hace ${dur(m)}`;
  };
  const dayTime = (ms) => new Date(ms).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const UPDATE_TIP = 'Claude Code guarda este dato cuando consulta tu uso a Anthropic (por ejemplo al escribir /usage). La extensión solo lo lee: no se conecta a nada.';

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
        h('h4', { title: 'Tu límite de uso de 5 horas, según Anthropic. Cuenta todo: Claude Code, claude.ai, Cowork y otros equipos.' },
          ['Límite de 5 h', h('span', { class: 'right', title: `La ventana termina a las ${hm(off.five.resetsAt)}; entonces el % vuelve a 0.` }, 'se reinicia ' + hm(off.five.resetsAt))]),
        h('div', { title: `Has usado el ${pct} % de tu límite de 5 horas. Quedan ${dur(mins)} para que se reinicie (a las ${hm(off.five.resetsAt)}).` }, [
          h('span', { class: 'pct ' + cls }, 'en ' + dur(mins)),
          h('span', { class: 'big' }, [pct + '%', h('span', { class: 'of' }, ' usado · oficial')]),
        ]),
        waffle([{ value: pct, cls: 'b-used' + (cls ? ' ' + cls : '') }], 100,
          `Cada cuadrado es el 1 % de tu límite de 5 horas. Llevas ${pct} de 100.`),
      );
    } else if (off.expiredAt) {
      const next = b && b.alignedToOfficial ? b.end : null;
      sec.append(
        h('h4', { title: 'Tu límite de uso de 5 horas, según Anthropic.' },
          ['Límite de 5 h', next ? h('span', { class: 'right', title: 'Calculado encadenando ventanas de 5 h desde el último reinicio oficial.' }, 'se reinicia ~' + hm(next)) : null]),
        h('div', { class: 'muted', title: UPDATE_TIP },
          `Se reinició a las ${hm(off.expiredAt)}.` + (next ? ` La ventana actual termina hacia las ${hm(next)}.` : ' La siguiente empieza con tu próximo mensaje.')
          + ' El nuevo % aparecerá cuando Claude Code lo vuelva a consultar (por ejemplo con /usage).'),
      );
    }
    if (off.week) {
      const wcls = off.week.pct >= 95 ? 'bad' : off.week.pct >= cfg.blockWarnRatio * 100 ? 'warn' : '';
      const parts = (off.breakdown || []).map(r => `${r.name}: ${r.percent} %`).join(', ');
      sec.append(
        h('div', { class: 'weekrow', title: `Llevas el ${off.week.pct} % de tu límite semanal. Se reinicia el ${dayTime(off.week.resetsAt)}.`
          + (parts ? ` Reparto de lo usado esta semana: ${parts}.` : '') }, [
          h('span', { class: 'muted' }, 'Semanal'),
          h('span', { class: 'bar' }, h('i', { class: 'fill ' + wcls, style: 'width:' + Math.min(100, off.week.pct) + '%' })),
          h('span', { class: 'v' }, off.week.pct + '%'),
        ]),
        h('div', { class: 'muted small' }, 'se reinicia ' + dayTime(off.week.resetsAt)
          + (off.breakdown && off.breakdown.length ? ' · ' + off.breakdown.map(r => `${r.name} ${r.percent}%`).join(' · ') : '')),
      );
    }
    if (off.fetchedAt) sec.append(h('div', { class: 'note muted', title: UPDATE_TIP }, `Dato oficial de ${ago(off.fetchedAt)}`));
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
        ? 'La ventana de 5 h actual del límite oficial. Aquí solo se ve Claude Code de este ordenador (no claude.ai, Cowork ni otros equipos).'
        : 'Sin dato oficial, la ventana se estima con Claude Code de este ordenador: empieza con tu primer mensaje y dura 5 horas.',
    }, [aligned ? 'Ventana actual' : 'Bloque de 5 h (estimado)', b ? h('span', { class: 'right', title: 'Inicio y fin de la ventana.' }, hm(b.start) + ' → ' + hm(b.end)) : null])]);
    if (!b) {
      sec.append(h('div', { class: 'muted' }, 'Sin actividad de Claude Code en este ordenador en la ventana actual.'));
      return sec;
    }

    // 1) Este proyecto
    const cur = b.currentProject;
    const curName = (st.live && st.live.project) || ((b.projects || []).find(p => p.current) || {}).name || 'Este proyecto';
    if (cur) {
      sec.append(
        h('div', { class: 'sub', title: `Lo que ha gastado Claude Code en ${curName} (todos sus chats y subagentes) dentro de la ventana actual.` }, [
          h('span', { class: 'muted' }, 'Este proyecto · '), curName,
        ]),
        h('div', { title: `${curName}: ${num(cur.freshTokens)} tokens sin contar las relecturas de caché (${fmt(cur.tokens)} contándolas) en esta ventana.` }, [
          h('span', { class: 'big' }, [fmt(cur.freshTokens), h('span', { class: 'of' }, ' sin caché · ' + fmt(cur.tokens) + ' total')]),
        ]),
        rows([
          ['Ritmo (30 min)', cur.perMinFresh > 0 ? fmt(cur.perMinFresh) + '/min' : 'parado', 'Tokens por minuto (sin caché leída) de este proyecto en los últimos 30 minutos.'],
          ['Llamadas', String(cur.calls), 'Llamadas al modelo de este proyecto en esta ventana.'],
          cfg.showCost ? ['Coste equiv. API', money(cur.cost), 'Lo que costaría por la API a precio público. Con Pro o Max no es lo que pagas.'] : null,
        ]),
      );
    }

    // 2) Todos los proyectos de este ordenador
    const ratio = max && max.freshTokens ? b.freshTokens / max.freshTokens : 0;
    const cls = ratio >= 1 ? 'bad' : ratio >= cfg.blockWarnRatio ? 'warn' : '';
    const others = (b.projects || []).filter(p => !p.current && p.recentFresh > 0).map(p => p.name);
    const allTip = 'El límite de 5 h cuenta todo lo que usas, en todos tus proyectos (y también claude.ai y Cowork). '
      + `En esta ventana, Claude Code de este ordenador lleva ${num(b.freshTokens)} tokens sin caché leída (${fmt(b.tokens)} contándola).`
      + (others.length ? ` Ahora mismo está trabajando en: ${others.join(', ')}; por eso este total sube aunque no hagas nada aquí.` : '')
      + (max ? ` Es el ${Math.round(ratio * 100)} % de tu bloque más grande.` : '');
    sec.append(
      h('div', { class: 'sub', title: allTip }, [h('span', { class: 'muted' }, 'Todos tus proyectos · '), 'este ordenador']),
      h('div', { title: allTip }, [
        max ? h('span', { class: 'pct ' + cls, title: 'Comparado con tu bloque de 5 h más grande en este ordenador.' }, Math.round(ratio * 100) + '% de tu máx.') : null,
        h('span', { class: 'big' }, [fmt(b.freshTokens), h('span', { class: 'of' }, ' sin caché · ' + fmt(b.tokens) + ' total')]),
      ]),
    );
    const list = b.projects || [];
    if (list.length) {
      const top = list[0].freshTokens || 1;
      sec.append(h('div', { class: 'projlist' }, list.map(p => h('div', {
        class: 'projrow' + (p.current ? ' current' : ''),
        title: `${p.name}: ${num(p.freshTokens)} tokens sin caché (${fmt(p.tokens)} con caché), ${p.calls} llamadas en esta ventana.`
          + (p.recentFresh > 0 ? ' Ha trabajado en los últimos 30 minutos.' : ' Sin actividad en los últimos 30 minutos.')
          + (p.current ? ' Es el proyecto abierto.' : ''),
      }, [
        h('span', { class: 'pname' }, [p.recentFresh > 0 ? h('i', { class: 'live' }) : null, p.name]),
        h('span', { class: 'pbar' }, h('i', { class: 'fill', style: 'width:' + Math.max(2, p.freshTokens / top * 100).toFixed(1) + '%' })),
        h('span', { class: 'v' }, fmt(p.freshTokens)),
      ]))));
      if (b.otherProjects) sec.append(h('div', { class: 'muted small' }, `y ${b.otherProjects} proyecto${b.otherProjects === 1 ? '' : 's'} más`));
    }
    // Sin % oficial, los cuadraditos comparan el total con tu bloque más grande
    if (max && !hasOfficialPct) {
      const proj = Math.max(0, Math.min(b.projectedFresh, max.freshTokens) - b.freshTokens);
      sec.append(
        waffle([
          { value: Math.min(b.freshTokens, max.freshTokens), cls: 'b-used' + (cls ? ' ' + cls : '') },
          { value: proj, cls: 'b-proj' },
        ], max.freshTokens,
        `Cada cuadrado es el 1 % de tu bloque más grande (${fmt(max.freshTokens / 100)} tokens sin caché). `
          + `Rellenos: lo que llevas. Con borde: lo que llevarías al acabar el bloque si sigues al mismo ritmo. Apagados: lo que falta hasta tu máximo.`
          + (ratio >= 1 ? ' Ya has superado tu máximo.' : '')),
        legend([
          ['b-used', 'usado', 'Lo que llevas en este bloque (sin caché leída), todos los proyectos.'],
          ['b-proj', 'previsión', 'Lo que añadirías hasta que se reinicie si mantienes el ritmo de los últimos 30 minutos.'],
          ['free', 'hasta tu máximo', 'Lo que falta para igualar tu bloque más grande.'],
        ]),
      );
    }
    sec.append(rows([
      hasOfficialPct ? null : ['Se reinicia en', dur(b.minsLeft), `La ventana termina a las ${hm(b.end)}.` + (b.alignedToOfficial ? ' Calculado desde el último reinicio oficial.' : ' Estimado.')],
      max ? ['Tu bloque más grande', fmt(max.freshTokens) + ' (' + day(max.start) + ')', 'La ventana de 5 h en la que más ha gastado Claude Code en este ordenador (sin caché leída, todos los proyectos).'] : null,
      ['Ritmo total (30 min)', fmt(b.perMinFresh) + '/min', 'Tokens por minuto (sin caché leída) de todos tus proyectos en los últimos 30 minutos.'],
      ['Si sigues así', fmt(b.projectedFresh), 'Lo que llevarías entre todos los proyectos al terminar la ventana si se mantiene el ritmo actual.'],
      ['Llamadas', String(b.calls), 'Llamadas al modelo en esta ventana, de todos tus proyectos.'],
      cfg.showCost ? ['Coste equiv. API', money(b.cost), 'Lo que costaría por la API a precio público, todos los proyectos. Con Pro o Max no es lo que pagas.'] : null,
    ]));
    if (!hasOfficialPct && max && b.projectedFresh > max.freshTokens && ratio < 1) {
      sec.append(h('div', { class: 'warnline' }, '⚠ A este ritmo superarás tu bloque más grande antes de que se reinicie.'));
    }
    if (!max) sec.append(h('div', { class: 'note muted' }, st.scanDone ? 'Aún no hay bloques anteriores para comparar.' : 'Calculando tus bloques anteriores…'));
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
      // Qué chat se está midiendo: un chat nuevo no aparece hasta su primer mensaje
      const when = s.firstTs ? day(Date.parse(s.firstTs)) + ' ' + hm(Date.parse(s.firstTs)) : '';
      kids.push(h('div', { class: 'chat muted small', title: `Se mide el chat más reciente de esta carpeta: «${s.title}». `
        + 'Un chat nuevo aparece aquí en cuanto envías su primer mensaje; hasta entonces Claude Code no crea su archivo y se sigue viendo el anterior.' },
        `Chat del ${when} · ${s.prompts} ${s.prompts === 1 ? 'pregunta' : 'preguntas'}`));
      kids.push(contextSection(s, st.cfg), lastCallSection(s), sessionSection(s, st.cfg), promptSection(s.lastPrompt, st.cfg));
    } else {
      kids.push(h('div', { class: 'empty' }, 'No hay ninguna sesión de Claude Code en esta carpeta todavía. En cuanto escribas a Claude aparecerá aquí.'));
    }
    kids.push(officialSection(st), blockSection(st));
    kids.push(h('button', { onclick: () => vscode.postMessage({ type: 'openPanel' }), title: 'Histórico de sesiones, gráfico por pregunta y bloques anteriores.' }, 'Abrir panel completo'));
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
