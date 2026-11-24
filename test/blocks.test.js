'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const B = require('../src/blocks');
const { tmpDir, assistantLine, writeLines } = require('./helpers');

const H = 3600 * 1000;
const usage = (o) => ({ input: 0, output: 0, cw5m: 0, cw1h: 0, cacheRead: 0, ...o });
// Hora en punto local, para que el redondeo a la hora sea predecible en cualquier zona
const T0 = (() => { const d = new Date('2026-11-24T00:00:00'); return d.getTime(); })();
const call = (id, ts, u = { input: 1 }) => ({ id, ts, model: 'claude-opus-5-5', usage: usage(u) });
const starts = (blocks) => blocks.map(b => (b.start - T0) / H);

test('buildBlocks: el bloque empieza en la hora en punto y dura 5 h', () => {
  const blocks = B.buildBlocks([call('a', T0 + 1.5 * H), call('b', T0 + 6.4 * H), call('c', T0 + 6.6 * H)]);
  assert.deepEqual(starts(blocks), [1, 6]);
  assert.equal(blocks[0].end - blocks[0].start, 5 * H);
  assert.equal(blocks[1].calls, 2);
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

test('LiveBlocks: lee todos los proyectos, quita duplicados entre archivos y calcula el ritmo', (t) => {
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
  assert.equal(lb.poll(now, true), true);
  const cur = lb.current(now);
  assert.ok(cur);
  assert.equal(cur.calls, 2);
  assert.equal(cur.freshTokens, 450);
  assert.equal(cur.tokens, 10_450);
  assert.equal(Math.round(cur.perMinFresh), 15); // 450 tokens en 30 min
  assert.ok(cur.projectedFresh >= cur.freshTokens);
});

test('LiveBlocks: sin actividad en las últimas 5 h no hay bloque actual', (t) => {
  const root = tmpDir(t);
  const now = Date.now();
  writeLines(path.join(root, 'p', 'a.jsonl'), [assistantLine('m', now - 6 * H, { input: 1 })]);
  const lb = new B.LiveBlocks(null, root);
  lb.poll(now, true);
  assert.equal(lb.current(now), null);
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
