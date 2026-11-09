import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { parseEsAmount, formatEur } from '../src/money.js';
import { parseEndesaBill } from '../src/parseEndesaBill.js';
import { splitLuz } from '../src/splitLuz.js';
import { parseReading } from '../src/parseReading.js';

const sample = await readFile(new URL('./fixtures/endesa_oct_2026_detalle.txt', import.meta.url), 'utf8');

test('money: Spanish amounts to cents and back', () => {
  assert.equal(parseEsAmount('70,48'), 7048);
  assert.equal(parseEsAmount('-1,01'), -101);
  assert.equal(parseEsAmount('1.234,56'), 123456);
  assert.equal(formatEur(3228), '32,28 €');
  assert.equal(formatEur(-101), '-1,01 €');
  assert.equal(formatEur(123456), '1.234,56 €');
});

test('parseEndesaBill: October 2026 bill', () => {
  const bill = parseEndesaBill(sample);
  assert.equal(bill.invoiceNo, 'P26CON046489044');
  assert.equal(bill.periodFrom, '2026-10-07');
  assert.equal(bill.periodTo, '2026-11-01');
  assert.equal(bill.days, 26);
  assert.equal(bill.issuedAt, '2026-11-06');
  assert.equal(bill.totalCents, 7048);
  assert.equal(bill.kwhTotal, 233.251);
  assert.deepEqual(bill.errors, []);

  const byKey = (k) => bill.items.filter((i) => i.key === k).reduce((s, i) => s + i.amountCents, 0);
  assert.equal(byKey('power'), 2144);
  assert.equal(bill.items.filter((i) => i.key === 'power').length, 2, 'both power lines kept');
  assert.equal(byKey('energy'), 3369);
  assert.equal(byKey('discount'), -101);
  assert.equal(byKey('bono_social'), 64);
  assert.equal(byKey('meter_rental'), 69);
  assert.equal(byKey('electricity_tax'), 280);
  assert.equal(byKey('vat'), 1223);

  const kinds = Object.fromEntries(bill.items.map((i) => [i.key, i.kind]));
  assert.deepEqual(kinds, {
    power: 'fixed', energy: 'variable', discount: 'variable', bono_social: 'fixed',
    meter_rental: 'fixed', electricity_tax: 'tax', vat: 'tax',
  });
});

test('parseEndesaBill: unknown line and sum mismatch are reported', () => {
  const tampered = sample.replace(
    'TOTAL 70,48 €',
    'Servicio de asistencia hogar ........................5,00 €\nTOTAL 70,48 €',
  );
  const bill = parseEndesaBill(tampered);
  const unknown = bill.items.find((i) => i.kind === 'unknown');
  assert.ok(unknown, 'unknown line kept as item');
  assert.equal(unknown.amountCents, 500);
  assert.ok(bill.errors.some((e) => /desconocida/i.test(e)));
  assert.ok(bill.errors.some((e) => /no suman/i.test(e)));
});

test('parseEndesaBill: not an Endesa bill', () => {
  const bill = parseEndesaBill('hello world');
  assert.ok(bill.errors.length > 0);
});

test('splitLuz: neighbor 100 kWh of the October bill', () => {
  const bill = parseEndesaBill(sample);
  const s = splitLuz(bill.items, { kwhTotal: bill.kwhTotal, neighborKwh: 100, totalCents: bill.totalCents });
  assert.equal(s.neighborCents, 3228);
  assert.equal(s.homeCents, 3820);
  assert.equal(s.marcelaCents, 1273);
  assert.equal(s.yannAdrianaCents, 2547);
  assert.equal(s.neighborCents + s.homeCents, 7048);
  assert.equal(s.marcelaCents + s.yannAdrianaCents, s.homeCents);
  assert.equal(Math.round(s.taxRatioNeighbor * 1000) / 10, 45.8);
  assert.equal(s.pretax.neighbor, 2540);
  assert.equal(s.pretax.home, 3005);
  assert.equal(s.taxes.neighbor, 688);
  assert.equal(s.taxes.home, 815);
  assert.deepEqual(s.warnings, []);
  // Fixed lines are split 50/50
  const power = s.lines.find((l) => l.key === 'power');
  assert.equal(power.neighborCents, 536);
  // Every column adds up: lines -> subtotals -> totals
  const sum = (arr, k) => arr.reduce((t, l) => t + l[k], 0);
  const pre = s.lines.filter((l) => l.kind !== 'tax');
  const tax = s.lines.filter((l) => l.kind === 'tax');
  assert.equal(sum(pre, 'neighborCents'), s.pretax.neighbor);
  assert.equal(sum(pre, 'homeCents'), s.pretax.home);
  assert.equal(sum(tax, 'neighborCents'), s.taxes.neighbor);
  assert.equal(sum(tax, 'homeCents'), s.taxes.home);
  assert.equal(s.pretax.neighbor + s.taxes.neighbor, s.neighborCents);
  assert.equal(s.pretax.home + s.taxes.home, s.homeCents);
  for (const l of s.lines) assert.equal(l.neighborCents + l.homeCents, l.amountCents);
});

test('splitLuz: edge cases', () => {
  const bill = parseEndesaBill(sample);
  const opts = { kwhTotal: bill.kwhTotal, totalCents: bill.totalCents };

  const zero = splitLuz(bill.items, { ...opts, neighborKwh: 0 });
  assert.equal(zero.neighborCents + zero.homeCents, 7048);
  assert.ok(zero.neighborCents > 0, 'neighbor still pays half the fixed part');

  for (let kwh = 0; kwh <= 233; kwh += 7.3) {
    const r = splitLuz(bill.items, { ...opts, neighborKwh: kwh });
    assert.equal(r.neighborCents + r.homeCents, 7048, `reconciles at ${kwh} kWh`);
    assert.equal(r.lines.reduce((t, l) => t + l.homeCents, 0), r.homeCents, `home column adds up at ${kwh} kWh`);
  }

  const all = splitLuz(bill.items, { ...opts, neighborKwh: bill.kwhTotal });
  assert.equal(all.neighborCents + all.homeCents, 7048);
  assert.ok(all.neighborCents > all.homeCents);

  assert.throws(() => splitLuz(bill.items, { ...opts, neighborKwh: -1 }), /negativ/i);

  const over = splitLuz(bill.items, { ...opts, neighborKwh: 300 });
  assert.ok(over.warnings.length > 0);

  assert.throws(
    () => splitLuz([...bill.items, { key: 'x', label: 'x', kind: 'unknown', amountCents: 5 }], { ...opts, neighborKwh: 1 }),
    /sin clasificar/i,
  );
});

test('parseReading: typed meter readings', () => {
  assert.equal(parseReading('12345'), 12345);
  assert.equal(parseReading('12.345'), 12345);
  assert.equal(parseReading('1.234.567'), 1234567);
  assert.equal(parseReading('12345,6'), 12345.6);
  assert.equal(parseReading(' lectura 12345 kWh '), 12345);
  assert.equal(parseReading('12345.6'), 12345.6);
  assert.equal(parseReading('-5'), -5);
  assert.equal(parseReading('hola'), null);
  assert.equal(parseReading(''), null);
});

const realPdf = new URL('../fixtures/luz_oct_2026.pdf', import.meta.url);
const hasRealPdf = await access(realPdf).then(() => true, () => false);
test('real PDF (local only): extract + parse reconciles', { skip: !hasRealPdf && 'fixtures/luz_oct_2026.pdf not present' }, async () => {
  const { pdfText } = await import('../src/pdf.js');
  const bill = parseEndesaBill(await pdfText(await readFile(realPdf)));
  assert.deepEqual(bill.errors, []);
  assert.equal(bill.totalCents, 7048);
  assert.equal(bill.kwhTotal, 233.251);
});
