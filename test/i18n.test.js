import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DICTS, makeT, formatMoney, formatNumber, pickLang } from '../src/i18n.js';

test('English and Spanish have exactly the same keys', () => {
  const en = Object.keys(DICTS.en).sort();
  const es = Object.keys(DICTS.es).sort();
  assert.deepEqual(es.filter((k) => !en.includes(k)), [], 'keys only in Spanish');
  assert.deepEqual(en.filter((k) => !es.includes(k)), [], 'keys missing in Spanish');
});

test('every t("key") used in views, scripts and routes exists', () => {
  const files = [
    ...readdirSync(new URL('../views/', import.meta.url)).filter((f) => f.endsWith('.ejs')).map((f) => `../views/${f}`),
    '../views/partials/head.ejs', '../public/new.js', '../src/app.js',
  ];
  const missing = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const [, key] of src.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)) if (!(key in DICTS.en)) missing.push(`${f}: ${key}`);
  }
  assert.deepEqual(missing, []);
});

test('interpolation and formatting', () => {
  assert.equal(makeT('es')('bill.youPay', { name: 'Yann' }), 'Pagas a Yann');
  assert.equal(makeT('en')('bill.youPay', { name: 'Yann' }), 'You pay Yann');
  assert.equal(makeT('xx')('bill.total'), 'Total', 'unknown language falls back to English');
  assert.equal(formatMoney(3228, 'es'), '32,28 €');
  assert.equal(formatMoney(123456, 'es'), '1.234,56 €');
  assert.equal(formatMoney(-101, 'es'), '-1,01 €');
  assert.equal(formatMoney(3228, 'en'), '€32.28');
  assert.equal(formatNumber(233.251, 'es'), '233,251');
  assert.equal(formatNumber(45.8, 'es', 1), '45,8');
  assert.equal(formatNumber(233.251, 'en'), '233.251');
});

test('language choice: saved preference, else browser, else English', () => {
  assert.equal(pickLang('es', 'en-US'), 'es');
  assert.equal(pickLang(null, 'es-ES,es;q=0.9,en;q=0.8'), 'es');
  assert.equal(pickLang(null, 'fr-FR,fr;q=0.9,es;q=0.5'), 'es');
  assert.equal(pickLang(null, 'en-GB,en;q=0.9'), 'en');
  assert.equal(pickLang(null, 'de-DE'), 'en');
  assert.equal(pickLang(null, ''), 'en');
});
