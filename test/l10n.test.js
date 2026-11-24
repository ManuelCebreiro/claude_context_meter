'use strict';
// Traducciones: cada texto que se pasa a t('…') (extensión y webviews) y cada `%clave%`
// de package.json debe estar traducido al español, con los mismos {0}, {1}…
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const json = (f) => JSON.parse(read(f));

// Claves: el primer argumento literal de t('…'), más los textos que parser.js pone en
// inglés y la extensión traduce al mostrarlos (motivos de la ventana y textos de relleno).
function sourceKeys() {
  const keys = new Set();
  for (const f of ['src/extension.js', 'media/view.js', 'media/panel.js']) {
    for (const m of read(f).matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\(.)/g, '$1'));
  }
  const parser = read('src/parser.js');
  for (const m of parser.matchAll(/reason: '([^']*)'/g)) keys.add(m[1]);
  for (const k of ['(unknown)', '(no prompts)', '[image]']) {
    assert.ok(parser.includes(`'${k}'`), `parser.js ya no usa ${k}`);
    keys.add(k);
  }
  return keys;
}

const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',');

test('l10n: todos los textos de la interfaz están traducidos al español', () => {
  const es = json('l10n/bundle.l10n.es.json');
  const keys = sourceKeys();
  assert.ok(keys.size > 100, 'se encuentran las claves');
  const missing = [...keys].filter(k => !(k in es));
  assert.deepEqual(missing, [], 'faltan en l10n/bundle.l10n.es.json');
  const stale = Object.keys(es).filter(k => !keys.has(k));
  assert.deepEqual(stale, [], 'sobran en l10n/bundle.l10n.es.json');
  for (const k of keys) assert.equal(placeholders(es[k]), placeholders(k), `argumentos distintos en: ${k}`);
});

test('l10n: package.json usa package.nls.json y package.nls.es.json', () => {
  const pkg = read('package.json');
  const en = json('package.nls.json');
  const es = json('package.nls.es.json');
  const used = new Set([...pkg.matchAll(/"%([^%"]+)%"/g)].map(m => m[1]));
  assert.ok(used.size > 10);
  for (const k of used) {
    assert.ok(k in en, `falta ${k} en package.nls.json`);
    assert.ok(k in es, `falta ${k} en package.nls.es.json`);
  }
  assert.deepEqual(Object.keys(en).sort(), [...used].sort(), 'package.nls.json tiene claves sin usar');
  assert.deepEqual(Object.keys(es).sort(), [...used].sort(), 'package.nls.es.json tiene claves sin usar');
  assert.equal(json('package.json').l10n, './l10n');
});

if (process.env.PRINT_L10N_KEYS) console.log(JSON.stringify([...sourceKeys()], null, 1));
