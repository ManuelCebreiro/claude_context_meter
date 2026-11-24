'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/parser');
const { tmpDir, userLine, assistantLine, writeLines } = require('./helpers');

const M = 1_000_000;
const usage = (o) => ({ input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, ...o });
const T0 = Date.parse('2026-11-24T10:00:00Z');

// ── Ventana de contexto ─────────────────────────────────────────────────────
test('contextWindowFor: 1M por defecto en los modelos nuevos', () => {
  for (const m of ['claude-fable-5-2', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-4-7', 'claude-opus-4-8',
    'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.equal(P.contextWindowFor(m).size, M, m);
  }
});

test('contextWindowFor: 200K en Opus/Sonnet 4.6 sin [1m] y en modelos antiguos', () => {
  for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5']) {
    assert.equal(P.contextWindowFor(m).size, 200_000, m);
  }
});

test('contextWindowFor: [1m], modelo [1m] configurado y sesión que ya pasó de 200K', () => {
  assert.equal(P.contextWindowFor('claude-opus-4-6[1m]').size, M);
  assert.equal(P.contextWindowFor('claude-sonnet-4-6', 0, { model1m: true }).size, M);
  assert.equal(P.contextWindowFor('claude-sonnet-4-6', 0, { observedOver200k: true }).size, M);
  assert.equal(P.contextWindowFor('modelo-desconocido', 0, { observedOver200k: true }).size, M);
});

test('contextWindowFor: CLAUDE_CODE_DISABLE_1M_CONTEXT y el ajuste manual mandan', () => {
  assert.equal(P.contextWindowFor('claude-opus-5-5', 0, { disable1m: true }).size, 200_000);
  assert.equal(P.contextWindowFor('claude-opus-5-5', 500_000, { disable1m: true }).size, 500_000);
});

// ── Precios ─────────────────────────────────────────────────────────────────
test('callCost: Fable/Mythos 5.2 tienen su propia tarifa', () => {
  const u = usage({ input: M, output: M, cacheRead: M });
  assert.equal(P.callCost('claude-fable-5-2', u), 8 + 40 + 0.2);
  assert.equal(P.callCost('claude-mythos-5-2', u), 8 + 40 + 0.2);
  assert.equal(P.callCost('claude-fable-5-1', u), 10 + 50 + 0.25);
});

test('callCost: Opus 5.5, Sonnet 5.5 y escritura en caché de 5 min / 1 h', () => {
  assert.equal(P.callCost('claude-opus-5-5', usage({ input: M, output: M })), 24);
  assert.equal(P.callCost('claude-sonnet-5-5', usage({ cw5m: M, cw1h: M, cacheRead: M })), 2.5 + 4 + 0.1);
});

test('callCost: Haiku 5.5 multiplica por 5 por encima de 100K de prompt', () => {
  assert.ok(Math.abs(P.callCost('claude-haiku-5-5', usage({ input: 100_000 })) - 0.01) < 1e-12);
  assert.ok(Math.abs(P.callCost('claude-haiku-5-5', usage({ input: 100_001 })) - 100_001 * 0.5 / M) < 1e-12);
});

test('callCost: priceOverrides tiene prioridad', () => {
  assert.equal(P.callCost('claude-opus-5-5', usage({ input: M }), { 'opus-5-5': [1, 1, 1, 1, 1] }), 1);
});

// ── Uso ─────────────────────────────────────────────────────────────────────
test('readUsage: separa la escritura en caché de 5 min y 1 h cuando viene desglosada', () => {
  const u = P.readUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } });
  assert.deepEqual(u, { input: 1, output: 2, cw5m: 10, cw1h: 20, cacheRead: 3 });
});

test('readUsage: sin desglose, toda la escritura cuenta como 1 h', () => {
  assert.deepEqual(P.readUsage({ cache_creation_input_tokens: 7 }), { input: 0, output: 0, cw5m: 0, cw1h: 7, cacheRead: 0 });
});

test('contextOf, freshOf y usageTotal', () => {
  const u = usage({ input: 1, output: 2, cw5m: 4, cw1h: 8, cacheRead: 16 });
  assert.equal(P.contextOf(u), 1 + 4 + 8 + 16);
  assert.equal(P.freshOf(u), 1 + 2 + 4 + 8);
  assert.equal(P.usageTotal(u), 31);
});

// ── SessionState ────────────────────────────────────────────────────────────
function feed(lines) {
  const st = new P.SessionState('/x/abc.jsonl', null);
  for (const l of lines) st.feedLine(l);
  return st;
}

test('SessionState: varias líneas con el mismo message.id cuentan una sola vez (la última)', () => {
  const st = feed([
    userLine('hola', T0, { cwd: '/proyecto' }),
    assistantLine('msg_1', T0 + 1000, { input: 10, output: 1 }),
    assistantLine('msg_1', T0 + 1000, { input: 10, output: 50 }),
  ]);
  const s = st.summary();
  assert.equal(s.apiCalls, 1);
  assert.equal(s.totals.output, 50);
  assert.equal(s.cwd, '/proyecto');
});

test('SessionState: el contexto actual es la última llamada del hilo principal', () => {
  const s = feed([
    userLine('una', T0),
    assistantLine('a', T0 + 1000, { input: 5, cw: 100, cacheRead: 1000, output: 9 }),
    assistantLine('b', T0 + 2000, { input: 5, cacheRead: 2000, output: 9 }),
    assistantLine('sub', T0 + 3000, { input: 50_000 }, { isSidechain: true }),
  ]).summary();
  assert.equal(s.currentContext, 2005);
  assert.equal(s.peakContext, 2005);
  assert.equal(s.subTotals.input, 50_000);
});

test('SessionState: preguntas, comandos y lo que no es una pregunta', () => {
  const st = feed([
    userLine('primera', T0),
    userLine('<command-name>/model</command-name><command-args>opus</command-args>', T0 + 1),
    JSON.stringify({ type: 'user', timestamp: new Date(T0 + 2).toISOString(), message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    userLine('<system-reminder>nada</system-reminder>', T0 + 3),
    userLine('meta', T0 + 4, { isMeta: true }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
    userLine('tras compactar', T0 + 5),
  ]);
  assert.deepEqual(st.prompts.map(p => p.text), ['primera', '/model opus', 'tras compactar']);
  assert.deepEqual(st.prompts.map(p => p.compactBefore), [false, false, true]);
});

test('SessionState: ignora <synthetic> y líneas que no son JSON', () => {
  const s = feed(['no es json', '{roto', assistantLine('s', T0, { input: 9 }, { model: '<synthetic>' })]).summary();
  assert.equal(s.apiCalls, 0);
});

test('SessionState: las llamadas de subagentes se asignan a la pregunta por hora', () => {
  const st = feed([userLine('p1', T0), userLine('p2', T0 + 10_000)]);
  st.feedSubagentCall('sub:1', 'claude-haiku-5-5', usage({ output: 7 }), new Date(T0 + 5000).toISOString());
  st.feedSubagentCall('sub:2', 'claude-haiku-5-5', usage({ output: 3 }), new Date(T0 + 15_000).toISOString());
  const s = st.summary();
  assert.equal(s.perPrompt[0].usage.output, 7);
  assert.equal(s.perPrompt[1].usage.output, 3);
  assert.equal(s.currentContext, 0, 'los subagentes no cuentan para el contexto');
});

// ── IncrementalReader ───────────────────────────────────────────────────────
test('IncrementalReader: no entrega una línea hasta que está completa', async (t) => {
  const f = path.join(tmpDir(t), 'a.jsonl');
  const got = [];
  const r = new P.IncrementalReader(f, (l) => got.push(l));
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  assert.equal(await r.poll(), true);
  assert.deepEqual(got, ['{"a":1}']);
  fs.appendFileSync(f, '2}\n');
  await r.poll();
  assert.deepEqual(got, ['{"a":1}', '{"b":2}']);
  assert.equal(await r.poll(), false, 'sin bytes nuevos');
});

test('IncrementalReader: un carácter UTF-8 cortado entre dos lecturas no se rompe', async (t) => {
  const f = path.join(tmpDir(t), 'u.jsonl');
  const bytes = Buffer.from('{"t":"año 🎉"}\n', 'utf8');
  const cut = bytes.indexOf(Buffer.from('ñ', 'utf8')) + 1; // a mitad de la ñ
  const got = [];
  const r = new P.IncrementalReader(f, (l) => got.push(l));
  fs.writeFileSync(f, bytes.subarray(0, cut));
  await r.poll();
  fs.appendFileSync(f, bytes.subarray(cut));
  await r.poll();
  assert.deepEqual(got.map(l => JSON.parse(l).t), ['año 🎉']);
});

test('IncrementalReader: si el archivo se acorta, avisa y vuelve a empezar', async (t) => {
  const f = path.join(tmpDir(t), 'r.jsonl');
  const got = [];
  const r = new P.IncrementalReader(f, (l) => got.push(l));
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n');
  await r.poll();
  fs.writeFileSync(f, '{"c":3}\n');
  assert.equal(await r.poll(), 'reset');
  await r.poll();
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('IncrementalReader: lee por trozos archivos de más de 1 MB sin perder líneas', async (t) => {
  const f = path.join(tmpDir(t), 'big.jsonl');
  const lines = [];
  for (let i = 0; i < 30_000; i++) lines.push(JSON.stringify({ i, pad: 'ñ'.repeat(30) }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 2 * (1 << 20));
  let n = 0, last = -1, ok = true;
  const r = new P.IncrementalReader(f, (l) => {
    const o = JSON.parse(l);
    if (o.i !== last + 1 || o.pad !== 'ñ'.repeat(30)) ok = false;
    last = o.i; n++;
  });
  await r.poll();
  assert.equal(n, 30_000);
  assert.ok(ok, 'líneas en orden y sin caracteres rotos');
});

test('IncrementalReader: dos lecturas a la vez no duplican líneas', async (t) => {
  const f = path.join(tmpDir(t), 'c.jsonl');
  fs.writeFileSync(f, '{"a":1}\n');
  const got = [];
  const r = new P.IncrementalReader(f, (l) => got.push(l));
  const [a, b] = await Promise.all([r.poll(), r.poll()]);
  assert.deepEqual([a, b], [true, false]);
  assert.deepEqual(got, ['{"a":1}']);
});

test('readWholeFile entrega la última línea aunque no acabe en salto de línea', async (t) => {
  const f = path.join(tmpDir(t), 'w.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":2}');
  const got = [];
  await P.readWholeFile(f, (l) => got.push(l));
  assert.deepEqual(got, ['{"a":1}', '{"b":2}']);
});

// ── Rutas y sesión activa ───────────────────────────────────────────────────
test('encodeProjectDir sustituye todo lo no alfanumérico por guiones', () => {
  assert.equal(P.encodeProjectDir('c:\\Users\\ana\\mi proyecto'), 'c--Users-ana-mi-proyecto');
  assert.equal(P.encodeProjectDir('/home/ana/app.v2'), '-home-ana-app-v2');
});

test('findActiveSession: elige el transcript más reciente del proyecto abierto', (t) => {
  const root = tmpDir(t);
  const ws = path.join(root, 'ws', 'mi-app');
  const dir = path.join(root, P.encodeProjectDir(ws));
  const old = path.join(dir, 'old.jsonl'), recent = path.join(dir, 'new.jsonl');
  writeLines(old, [userLine('x', T0, { cwd: ws })]);
  writeLines(recent, [userLine('y', T0, { cwd: ws })]);
  fs.utimesSync(old, new Date(T0), new Date(T0));
  assert.equal(P.findActiveSession([ws], root), recent);
});

test('findActiveSession: plan B encuentra sesiones abiertas en una subcarpeta', (t) => {
  const root = tmpDir(t);
  const ws = path.join(root, 'ws', 'mi-app');
  const sub = path.join(ws, 'packages', 'api');
  const f = path.join(root, P.encodeProjectDir(sub), 's.jsonl');
  writeLines(f, [userLine('z', T0, { cwd: sub })]);
  assert.equal(P.findActiveSession([ws], root), f);
  assert.equal(P.findActiveSession([path.join(root, 'otra')], root), null);
  assert.equal(P.findActiveSession([ws], root, { fallback: false }), null, 'sin plan B no la encuentra');
});

test('parseSessionFile incluye los archivos de subagentes', async (t) => {
  const root = tmpDir(t);
  const f = path.join(root, 'p', 'sess.jsonl');
  writeLines(f, [userLine('hola', T0), assistantLine('m1', T0 + 1000, { input: 10, output: 5 })]);
  writeLines(path.join(root, 'p', 'sess', 'subagents', 'agent-1.jsonl'),
    [assistantLine('s1', T0 + 2000, { input: 100, output: 20 }, { model: 'claude-haiku-5-5' })]);
  const s = await P.parseSessionFile(f, null, 0, {});
  assert.equal(s.apiCalls, 2);
  assert.equal(s.subTotals.output, 20);
  assert.equal(s.currentContext, 10);
});
