import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { makeService } from '../src/service.js';
import { makeWhatsApp } from '../src/whatsapp.js';
import { makeInbound } from '../src/inbound.js';
import { parseEndesaBill } from '../src/parseEndesaBill.js';

const sample = readFileSync(new URL('./fixtures/endesa_oct_2026_detalle.txt', import.meta.url), 'utf8');
const realPdf = new URL('../fixtures/luz_oct_2026.pdf', import.meta.url);
const realEml = new URL('../fixtures/endesa_email_P26CON046489044.eml', import.meta.url);
const P = { yann: '34600000001', adriana: '34600000002', marcela: '34600000003', neighbor: '34600000004' };

let dir, db, svc, inbound;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'samac-in-'));
  db = openDb(dir);
  svc = makeService({ db, dataDir: dir, publicUrl: 'https://bills.example' });
  const fakeFetch = async (url) => {
    if (url.startsWith('https://click.')) return new Response('var encDocumento = "D"; var encFactura = "F";');
    if (url.includes('ajax-validacion')) return new Response('https://cdn.endesaclientes.com/f.pdf');
    return new Response(readFileSync(realPdf));
  };
  inbound = makeInbound({ svc, wa: makeWhatsApp({ phoneNumberId: '123' }), publicUrl: 'https://bills.example', endesaNie: 'Z0000000T', fetchImpl: fakeFetch });
  const ins = db.prepare('INSERT INTO people (role, name, wa_phone) VALUES (?, ?, ?)');
  for (const [role, phone] of Object.entries(P)) ins.run(role, role === 'neighbor' ? 'Pepe' : role, phone);
  db.prepare(`INSERT INTO readings (bill_id, reading_kwh, source, status) VALUES (NULL, 12345, 'seed', 'seed')`).run();
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const newBill = () => svc.createBill({ parsed: parseEndesaBill(sample), source: 'auto' }).bill;
const types = (out) => out.outbox.map((m) => `${m.body.to}:${m.body.type}${m.body.template ? ':' + m.body.template.name : ''}`);
const textOf = (m) => m.body.text?.body ?? m.body.interactive?.body?.text ?? m.body.template?.components?.[0]?.parameters?.map((p) => p.text).join(' | ');

test('photo -> buttons -> Sí -> split to all 4, stale tap rejected', () => {
  const bill = newBill();
  let out = inbound.handleWhatsApp({ from: '+34 600 000 004', type: 'image', reading: 12445, photoBuffer: Buffer.from('jpg') });
  assert.deepEqual(types(out), [`${P.neighbor}:interactive`]);
  const btns = out.outbox[0].body.interactive.action.buttons;
  assert.equal(btns[0].reply.id, `ok|${bill.id}|12445`);
  assert.match(textOf(out.outbox[0]), /Anterior: 12345 → consumo 100 kWh/);
  assert.equal(out.outbox[0].url, 'https://graph.facebook.com/v27.0/123/messages');

  out = inbound.handleWhatsApp({ from: P.neighbor, type: 'button', button_id: btns[0].reply.id });
  assert.equal(out.mark_sent_bill_id, bill.id);
  assert.deepEqual(types(out).sort(), Object.values(P).map((p) => `${p}:template:samac_luz_reparto`).sort());
  assert.match(textOf(out.outbox[0]), /32,28 \| 12,73 \| 25,47/);
  // Photo is kept as evidence on the confirmed reading
  assert.ok(svc.billDetail(bill.id).readings.find((r) => r.status === 'confirmed').photo_path);

  out = inbound.handleWhatsApp({ from: P.neighbor, type: 'button', button_id: btns[0].reply.id });
  assert.deepEqual(types(out), [`${P.neighbor}:text`]);
  assert.match(textOf(out.outbox[0]), /ya no es válido/);
});

test('unreadable photo -> neighbor types the number -> split', () => {
  const bill = newBill();
  let out = inbound.handleWhatsApp({ from: P.neighbor, type: 'image', reading: null, photoBuffer: Buffer.from('jpg') });
  assert.match(textOf(out.outbox[0]), /No he podido leer/);
  out = inbound.handleWhatsApp({ from: P.neighbor, type: 'button', button_id: `no|${bill.id}` });
  assert.match(textOf(out.outbox[0]), /Escríbeme la lectura/);
  out = inbound.handleWhatsApp({ from: P.neighbor, type: 'text', text: '12.445' });
  assert.equal(out.action, 'split_sent');
  const r = svc.billDetail(bill.id).readings.find((x) => x.status === 'confirmed');
  assert.equal(r.reading_kwh, 12445);
  assert.ok(r.photo_path, 'unreadable photo still kept as evidence');
});

test('implausible reading -> neighbor thanked, Yann asked to review, then Yann overrides', () => {
  const bill = newBill();
  let out = inbound.handleWhatsApp({ from: P.neighbor, type: 'text', text: '13000' });
  assert.equal(out.action, 'needs_review');
  assert.deepEqual(types(out), [`${P.neighbor}:text`, `${P.yann}:template:samac_aviso`]);
  assert.equal(svc.getBill(bill.id).status, 'awaiting_reading');

  out = inbound.handleWhatsApp({ from: P.yann, type: 'text', text: 'kwh 50' });
  assert.equal(out.action, 'split_sent');
  assert.equal(types(out)[0], `${P.yann}:text`);
  assert.match(textOf(out.outbox[0]), /Recalculado/);
  assert.equal(out.outbox.length, 5);
  assert.equal(svc.billDetail(bill.id).split.neighbor_kwh, 50);
});

test('photo without open bill, other people ignored, help/estado for Yann', () => {
  let out = inbound.handleWhatsApp({ from: P.neighbor, type: 'image', reading: 1 });
  assert.deepEqual(types(out), [`${P.neighbor}:text`, `${P.yann}:template:samac_aviso`]);
  assert.equal(inbound.handleWhatsApp({ from: P.marcela, type: 'text', text: '123' }).outbox.length, 0);
  assert.equal(inbound.handleWhatsApp({ from: '34999999999', type: 'image', reading: 1 }).outbox.length, 0);
  assert.match(textOf(inbound.handleWhatsApp({ from: P.yann, type: 'text', text: 'hola' }).outbox[0]), /Comandos/);
  newBill();
  assert.match(textOf(inbound.handleWhatsApp({ from: P.yann, type: 'text', text: 'estado' }).outbox[0]), /awaiting_reading/);
});

test('data deletion request is acknowledged and forwarded to Yann', () => {
  const out = inbound.handleWhatsApp({ from: P.marcela, type: 'text', text: 'Hola, borrar mis datos por favor' });
  assert.deepEqual(types(out), [`${P.marcela}:text`, `${P.yann}:template:samac_aviso`]);
});

test('delivery failures notify Yann, but never about Yann himself', () => {
  assert.deepEqual(types(inbound.handleWhatsApp({ type: 'status_failed', recipient: P.marcela, error: 'x' })), [`${P.yann}:template:samac_aviso`]);
  assert.equal(inbound.handleWhatsApp({ type: 'status_failed', recipient: P.yann, error: 'x' }).outbox.length, 0);
});

test('template variables never contain newlines', () => {
  const wa = makeWhatsApp({ phoneNumberId: '1' });
  const m = wa.template('1', 'samac_aviso', ['a\nb    c']);
  assert.equal(m.body.template.components[0].parameters[0].text, 'a b   c');
});

test('endesa email -> bill + template to neighbor + notice to Yann; duplicates and non-luz ignored',
  { skip: !(existsSync(realPdf) && existsSync(realEml)) && 'local fixtures missing' }, async () => {
    const raw = readFileSync(realEml, 'utf8');
    const html = raw.slice(raw.indexOf('<'));
    let out = await inbound.handleEndesaEmail({ html });
    assert.equal(out.action, 'bill_created', JSON.stringify(out));
    assert.deepEqual(types(out), [`${P.neighbor}:template:samac_luz_pedir_lectura`, `${P.yann}:template:samac_aviso`]);
    assert.equal(textOf(out.outbox[0]), 'Pepe | 07/10/2026 | 01/11/2026');
    out = await inbound.handleEndesaEmail({ html });
    assert.equal(out.action, 'duplicate');
    assert.equal(out.outbox.length, 0);
    out = await inbound.handleEndesaEmail({ html: '<p>tu factura de gas</p>' });
    assert.equal(out.action, 'ignored_not_luz');
  });

test('endesa email with NIE rejected -> notice to Yann with manual link', async () => {
  const bad = makeInbound({
    svc, wa: makeWhatsApp({ phoneNumberId: '1' }), publicUrl: 'https://bills.example', endesaNie: 'Z0000000T',
    fetchImpl: async (url) => (url.includes('ajax') ? new Response('ERROR') : new Response('var encDocumento = "D"; var encFactura = "F";')),
  });
  const out = await bad.handleEndesaEmail({ html: 'factura de luz <a href="https://click.digital.endesaclientes.com/?qs=1">DESCARGAR FACTURA</a>' });
  assert.equal(out.action, 'error');
  assert.match(textOf(out.outbox[0]), /rechazó el documento.*bills\/new/);
});
