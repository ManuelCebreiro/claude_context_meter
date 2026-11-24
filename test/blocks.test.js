'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const B = require('../src/blocks');
const { tmpDir, assistantLine, writeLines } = require('./helpers');

const H = 3600 * 1000;
const usage = (o) => ({ input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, ...o });
// Hora en punto local, para que el redondeo a la hora sea predecible en cualquier zona
const T0 = (() => { const d = new Date('2026-11-24T00:00:00'); return d.getTime(); })();
const call = (id, ts, u = { input: 1 }) => ({ id, ts, model: 'claude-opus-5-5', usage: usage(u) });
const starts = (blocks) => blocks.map(b => (b.start - T0) / H);

test('buildBlocks: el bloque empieza con la primera llamada (al minuto, sin redondear a la hora) y dura 5 h', () => {
  const blocks = B.buildBlocks([call('a', T0 + 1.5 * H + 25_000), call('b', T0 + 6.4 * H), call('c', T0 + 6.6 * H)]);
  assert.deepEqual(starts(blocks), [1.5, 6.6]);
  assert.equal(blocks[0].end - blocks[0].start, 5 * H);
  assert.equal(blocks[0].calls, 2);
  assert.equal(blocks[1].calls, 1);
});

test('buildBlocks: cuenta total, sin caché leída y coste', () => {
  const [b] = B.buildBlocks([call('a', T0, { input: 10, output: 20, cw1h: 30, cacheRead: 1000 })]);
  assert.equal(b.tokens, 1060);
  assert.equal(b.freshTokens, 60);
  assert.ok(b.cost > 0);
});

test('buildBlocks: sin ancla, con uso continuo los bloques se desplazan', () => {
  const calls = [];
  for (let h = 0; h < 12; h += 0.5) calls.push(call('c' + h, T0 + h * H));
  assert.deepEqual(starts(B.buildBlocks(calls)), [0, 5, 10]);
  const window = calls.filter(c => c.ts >= T0 + 2 * H); // lo que ve LiveBlocks
  assert.deepEqual(starts(B.buildBlocks(window)), [2, 7], 'desplazado');
  assert.deepEqual(starts(B.buildBlocks(window, null, T0 + 5 * H)), [5, 10], 'alineado con el ancla');
});

test('buildBlocks: con ancla, las llamadas anteriores se ignoran', () => {
  const blocks = B.buildBlocks([call('a', T0 + 1 * H), call('b', T0 + 3.5 * H)], null, T0 + 3 * H);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start, T0 + 3 * H);
  assert.equal(blocks[0].first, T0 + 3.5 * H);
});

test('buildBlocks: un ancla sin llamadas no genera un bloque vacío', () => {
  assert.deepEqual(B.buildBlocks([], null, T0), []);
});

test('callFromLine: solo líneas de asistente con usage y timestamp', () => {
  assert.equal(B.callFromLine('{"type":"user"}'), null);
  assert.equal(B.callFromLine(assistantLine('x', T0, { input: 1 }, { model: '<synthetic>' })), null);
  const c = B.callFromLine(assistantLine('x', T0, { input: 3 }));
  assert.equal(c.id, 'x');
  assert.equal(c.ts, T0);
  assert.equal(c.usage.input, 3);
});

test('LiveBlocks: lee todos los proyectos, quita duplicados entre archivos y calcula el ritmo', async (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  writeLines(path.join(root, 'p1', 'a.jsonl'), [
    assistantLine('m1', now - 20 * 60000, { input: 100, output: 50, cacheRead: 10_000 }),
  ]);
  // una sesión reanudada copia mensajes antiguos con el mismo id
  writeLines(path.join(root, 'p2', 'b.jsonl'), [
    assistantLine('m1', now - 20 * 60000, { input: 100, output: 50, cacheRead: 10_000 }),
    assistantLine('m2', now - 10 * 60000, { input: 200, output: 100 }),
  ]);
  const lb = new B.LiveBlocks(null, root);
  assert.equal(await lb.poll(now, true), true);
  const cur = lb.current(now);
  assert.ok(cur);
  assert.equal(cur.calls, 2);
  assert.equal(cur.freshTokens, 450);
  assert.equal(cur.tokens, 10_450);
  assert.equal(Math.round(cur.perMinFresh), 15); // 450 tokens en 30 min
  assert.ok(cur.projectedFresh >= cur.freshTokens);
});

test('LiveBlocks: sin actividad en las últimas 5 h no hay bloque actual', async (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  writeLines(path.join(root, 'p', 'a.jsonl'), [assistantLine('m', now - 6 * H, { input: 1 })]);
  const lb = new B.LiveBlocks(null, root);
  await lb.poll(now, true);
  assert.equal(lb.current(now), null);
});

test('LiveBlocks.scanAll es incremental: la segunda vez solo lee lo nuevo', async (t) => {
  const root = tmpDir(t);
  const f = path.join(root, 'p', 'a.jsonl');
  writeLines(f, [assistantLine('n1', T0 + 1 * H, { input: 1 })]);
  const lb = new B.LiveBlocks(null, root);
  assert.deepEqual(starts(await lb.scanAll(T0)), [1]);
  const reader = lb.store.readers.get(f);
  const offset = reader.offset;
  fs.appendFileSync(f, assistantLine('n2', T0 + 8 * H, { input: 1 }) + '\n');
  assert.deepEqual(starts(await lb.scanAll(T0)), [1, 8]);
  assert.equal(lb.store.readers.get(f), reader, 'reutiliza el mismo lector');
  assert.ok(reader.offset > offset);
});

test('LiveBlocks: con ancla, el bloque actual sigue alineado tras 12 h de uso continuo', async (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  const hour = (() => { const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime(); })();
  // Llamadas cada 20 min desde hace 12 h: los bloques reales empiezan en hour-12, hour-7 y hour-2
  const lines = [];
  for (let m = 12 * 60; m >= 20; m -= 20) lines.push(assistantLine('c' + m, hour - m * 60000, { input: 1 }));
  writeLines(path.join(root, 'p', 'a.jsonl'), lines);
  const lb = new B.LiveBlocks(null, root);
  const all = await lb.scanAll(now - 90 * 24 * H);
  assert.deepEqual(all.map(b => (hour - b.start) / H), [12, 7, 2]);
  lb.anchor = all[all.length - 1].start;
  assert.equal(lb.current(now).start, hour - 2 * H);
});

test('LiveBlocks: el resultado se reutiliza mientras no cambia nada', async (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  writeLines(path.join(root, 'p', 'a.jsonl'), [assistantLine('m', now - 60000, { input: 1 })]);
  const lb = new B.LiveBlocks(null, root);
  await lb.poll(now, true);
  const a = lb.current(now);
  assert.equal(lb.current(now), a);
  lb.pricing = { 'opus-5-5': [1, 1, 1, 1, 1] };
  assert.notEqual(lb.current(now), a, 'al cambiar los precios se recalcula');
});

test('scanAllBlocks: escanea la carpeta indicada y respeta la fecha mínima', async (t) => {
  const root = tmpDir(t);
  writeLines(path.join(root, 'p', 'a.jsonl'), [
    assistantLine('viejo', T0 - 48 * H, { input: 1 }),
    assistantLine('n1', T0 + 1 * H, { input: 1 }),
    assistantLine('n2', T0 + 7 * H, { input: 1 }),
  ]);
  const blocks = await B.scanAllBlocks(null, T0, root);
  assert.deepEqual(starts(blocks), [1, 7]);
});

test('buildBlocks: con `after`, la primera llamada posterior abre el bloque', () => {
  const blocks = B.buildBlocks([call('a', T0 + 1 * H), call('b', T0 + 3.25 * H), call('c', T0 + 4 * H)], null, { after: T0 + 3 * H });
  assert.deepEqual(starts(blocks), [3.25]);
  assert.equal(blocks[0].calls, 2);
});

test('LiveBlocks: con reinicio oficial futuro, la ventana es la oficial', async (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  writeLines(path.join(root, 'p', 'a.jsonl'), [
    assistantLine('x', now - 3 * H, { input: 5 }),     // antes de la ventana oficial: no cuenta
    assistantLine('y', now - 30 * 60000, { input: 7 }),
  ]);
  const lb = new B.LiveBlocks(null, root);
  await lb.poll(now, true);
  const R = now + 4 * H + 10 * 60000;                   // la oficial termina dentro de 4 h 10 min
  lb.officialReset = R;
  const cur = lb.current(now);
  assert.equal(cur.start, R - 5 * H);
  assert.equal(cur.end, R);
  assert.equal(cur.freshTokens, 7);
  assert.equal(cur.alignedToOfficial, true);
});

test('LiveBlocks: si el reinicio oficial ya pasó, la ventana empieza con la primera llamada posterior', async (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  const R = now - 10 * 60000;                           // se reinició hace 10 min
  writeLines(path.join(root, 'p', 'a.jsonl'), [
    assistantLine('x', R - 60000, { input: 5 }),
    assistantLine('y', R + 20_000, { input: 7 }),        // 20 s después del reinicio
    assistantLine('z', now - 60000, { input: 9 }),
  ]);
  const lb = new B.LiveBlocks(null, root);
  await lb.poll(now, true);
  lb.officialReset = R;
  const cur = lb.current(now);
  assert.equal(cur.start, Math.floor((R + 20_000) / 60000) * 60000);
  assert.equal(cur.freshTokens, 16);
  assert.equal(cur.alignedToOfficial, true);
});

test('LiveBlocks: reparte la ventana por proyecto y separa el proyecto abierto', async (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  writeLines(path.join(root, 'c--Proyecto-A', 'a.jsonl'), [assistantLine('a1', now - 40 * 60000, { input: 100 })]);
  writeLines(path.join(root, 'c--Proyecto-A', 'a', 'subagents', 'agent.jsonl'), [assistantLine('a2', now - 35 * 60000, { output: 50 })]);
  writeLines(path.join(root, 'c--Proyecto-B', 'b.jsonl'), [assistantLine('b1', now - 5 * 60000, { input: 300, cacheRead: 9000 })]);
  const lb = new B.LiveBlocks(null, root);
  await lb.poll(now, true);
  lb.projectDirs = new Set(['c--proyecto-a']);
  const cur = lb.current(now);
  assert.deepEqual(cur.projects.map(p => [p.proj, p.freshTokens]), [['c--proyecto-b', 300], ['c--proyecto-a', 150]]);
  assert.equal(cur.currentProject.freshTokens, 150, 'el proyecto abierto incluye sus subagentes');
  assert.equal(cur.currentProject.recentFresh, 0, 'sin actividad en los últimos 30 min');
  assert.equal(cur.projects[0].recentFresh, 300, 'B está trabajando ahora');
  assert.equal(cur.freshTokens, 450, 'el total sigue siendo de todos los proyectos');
});
