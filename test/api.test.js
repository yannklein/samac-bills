import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { parseEndesaBill } from '../src/parseEndesaBill.js';
import { extractDownloadLink, extractTokens } from '../src/endesa.js';

const sample = readFileSync(new URL('./fixtures/endesa_oct_2026_detalle.txt', import.meta.url), 'utf8');
const realPdfPath = new URL('../fixtures/luz_oct_2026.pdf', import.meta.url);
const realEmlPath = new URL('../fixtures/endesa_email_P26CON046489044.eml', import.meta.url);
const TOKEN = 'test-token';

let dir, server, base, ctx;
const fakeEndesa = async (url, opts = {}) => {
  if (url.startsWith('https://click.digital.endesaclientes.com/')) {
    return new Response('<script>var encDocumento = "DOC=="; var encFactura = "FAC==";</script>', { status: 200 });
  }
  if (url.endsWith('/ajax-validacion-doc-aviso')) {
    const data = JSON.parse(decodeURIComponent(opts.body.replace(/^data=/, '')));
    assert.deepEqual(data, { Documento: 'Z0000000T', encDocumento: 'DOC==', encFactura: 'FAC==' });
    return new Response('https://cdn.example.endesaclientes.com/factura.pdf', { status: 200 });
  }
  if (url === 'https://cdn.example.endesaclientes.com/factura.pdf') {
    return new Response(readFileSync(realPdfPath), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'samac-'));
  ctx = createApp({
    dataDir: dir, publicUrl: 'https://bills.example', adminEmail: 'yann@example.com', apiToken: TOKEN,
    endesaNie: 'Z0000000T', devUserEmail: 'yann@example.com', cfTeamDomain: '', cfAud: '',
    n8nSendWebhookUrl: '', n8nWebhookToken: '',
  }, { fetchImpl: fakeEndesa });
  const ins = ctx.db.prepare('INSERT INTO people (role, name, wa_phone, email) VALUES (?, ?, ?, ?)');
  ins.run('yann', 'Yann', '34600000001', 'yann@example.com');
  ins.run('adriana', 'Adriana', '34600000002', 'adriana@example.com');
  ins.run('marcela', 'Marcela', '34600000003', 'marcela@example.com');
  ins.run('neighbor', 'Vecino', '34600000004', 'vecino@example.com');
  ctx.db.prepare(`INSERT INTO readings (bill_id, reading_kwh, source, status) VALUES (NULL, 1000, 'seed', 'seed')`).run();
  await new Promise((r) => { server = ctx.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const api = (p, opts = {}) => fetch(base + '/api' + p, {
  ...opts,
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
});

test('api requires the bearer token', async () => {
  const r = await fetch(base + '/api/people');
  assert.equal(r.status, 401);
  assert.equal((await api('/people')).status, 200);
});

test('full flow: bill -> candidate -> confirm -> sent, with stale-button protection', async () => {
  const { bill } = ctx.svc.createBill({ parsed: parseEndesaBill(sample), source: 'auto' });

  let r = await api('/bills/open');
  assert.equal(r.status, 200);
  const open = await r.json();
  assert.equal(open.bill_id, bill.id);
  assert.deepEqual(open.request_vars, ['Vecino', '07/10/2026', '01/11/2026']);

  const fd = new FormData();
  fd.append('reading', '1.100');
  fd.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'meter.jpg');
  r = await fetch(`${base}/api/bills/${bill.id}/candidate`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
  const cand = await r.json();
  assert.equal(r.status, 200, JSON.stringify(cand));
  assert.equal(cand.neighbor_kwh, 100);
  assert.deepEqual(cand.warnings, []);

  // Old button for a different reading is rejected
  r = await api(`/bills/${bill.id}/confirm`, { method: 'POST', body: JSON.stringify({ reading: 1099, expect_reading: 1099, source: 'vision' }) });
  assert.equal(r.status, 409);

  r = await api(`/bills/${bill.id}/confirm`, { method: 'POST', body: JSON.stringify({ reading: 1100, expect_reading: 1100, source: 'vision' }) });
  const msg = await r.json();
  assert.equal(r.status, 200, JSON.stringify(msg));
  assert.deepEqual(msg.split_vars, [
    'P26CON046489044', '07/10/2026', '01/11/2026', '70,48', '100', '32,28', '12,73', '25,47', `https://bills.example/bills/${bill.id}`,
  ]);
  assert.equal(msg.recipients.length, 4);

  // Double tap on the same button is rejected
  r = await api(`/bills/${bill.id}/confirm`, { method: 'POST', body: JSON.stringify({ reading: 1100, expect_reading: 1100 }) });
  assert.equal(r.status, 409);

  r = await api(`/bills/${bill.id}/sent`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(ctx.svc.getBill(bill.id).status, 'sent');
  assert.equal((await api('/bills/open')).status, 404);

  // Yann override after sending recomputes
  r = await api(`/bills/${bill.id}/confirm`, { method: 'POST', body: JSON.stringify({ neighbor_kwh: 0, source: 'override' }) });
  assert.equal(r.status, 200);
  assert.equal(ctx.svc.getBill(bill.id).status, 'ready');
});

test('wa/inbound accepts a base64 photo in JSON and answers with an outbox', async () => {
  const parsed = { ...parseEndesaBill(sample), invoiceNo: 'WA1', periodFrom: '2026-10-08', periodTo: '2026-11-02' };
  const { bill } = ctx.svc.createBill({ parsed, source: 'auto' });
  const r = await api('/wa/inbound', {
    method: 'POST',
    body: JSON.stringify({ from: '34600000004', type: 'image', reading: '1100', confidence: 'high', photo_base64: Buffer.from('fakejpg').toString('base64'), photo_mime: 'image/jpeg' }),
  });
  const out = await r.json();
  assert.equal(r.status, 200, JSON.stringify(out));
  assert.equal(out.outbox[0].body.type, 'interactive');
  const cand = ctx.svc.billDetail(bill.id).readings[0];
  assert.equal(cand.reading_kwh, 1100);
  assert.match(cand.photo_path, /\.jpg$/);
  ctx.db.prepare(`UPDATE bills SET status = 'superseded' WHERE id = ?`).run(bill.id);
});

test('duplicate invoice is a 409 and over-consumption needs override', async () => {
  assert.throws(() => ctx.svc.createBill({ parsed: parseEndesaBill(sample), source: 'auto' }), (e) => e.status === 409);

  const parsed = { ...parseEndesaBill(sample), invoiceNo: 'TEST2', periodFrom: '2026-11-01', periodTo: '2026-12-01' };
  const { bill } = ctx.svc.createBill({ parsed, source: 'auto' });
  // 500 kWh is more than the whole bill (233 kWh): typed input must be rejected, override accepted
  const r = await api(`/bills/${bill.id}/confirm`, { method: 'POST', body: JSON.stringify({ neighbor_kwh: 500, source: 'typed' }) });
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.equal(body.needs_override, true);
  const ok = await api(`/bills/${bill.id}/confirm`, { method: 'POST', body: JSON.stringify({ neighbor_kwh: 500, source: 'override' }) });
  assert.equal(ok.status, 200);
});

test('negative consumption is rejected even with override', async () => {
  const parsed = { ...parseEndesaBill(sample), invoiceNo: 'TEST3', periodFrom: '2026-12-01', periodTo: '2027-01-01' };
  const { bill } = ctx.svc.createBill({ parsed, source: 'auto' });
  const r = await api(`/bills/${bill.id}/confirm`, { method: 'POST', body: JSON.stringify({ neighbor_kwh: -5, source: 'override' }) });
  assert.equal(r.status, 422);
});

test('web: viewers can see, only admin can edit, strangers are blocked', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/bills/new`)).status, 200);
  assert.equal((await fetch(`${base}/?as=marcela@example.com`)).status, 200);
  assert.equal((await fetch(`${base}/bills/1?as=marcela@example.com`)).status, 200);
  assert.equal((await fetch(`${base}/bills/new?as=marcela@example.com`)).status, 403);
  const post = await fetch(`${base}/bills/1/paid?as=marcela@example.com`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'payer=neighbor',
  });
  assert.equal(post.status, 403);
  assert.equal((await fetch(`${base}/?as=stranger@example.com`)).status, 403);
  const page = await (await fetch(`${base}/bills/1`)).text();
  assert.match(page, /Desglose|Lecturas/);
});

test('endesa: token extraction', () => {
  assert.deepEqual(extractTokens('var encDocumento = "a+b=="; var encFactura = "c/d==";'), { encDocumento: 'a+b==', encFactura: 'c/d==' });
  assert.equal(extractTokens('<html></html>'), null);
});

test('endesa: download link from the real email (local only)', { skip: !existsSync(realEmlPath) && 'no .eml fixture' }, () => {
  const raw = readFileSync(realEmlPath, 'utf8');
  const link = extractDownloadLink(raw);
  assert.match(link, /^https:\/\/click\.digital\.endesaclientes\.com\/\?qs=/);
});

test('api: /endesa/fetch end to end with mocked Endesa (local only)', { skip: !existsSync(realPdfPath) && 'no PDF fixture' }, async () => {
  // Remove the bill created from the same invoice by the service test
  ctx.db.exec(`DELETE FROM payments; DELETE FROM splits; DELETE FROM readings WHERE bill_id IS NOT NULL; DELETE FROM bills;`);
  let r = await api('/endesa/fetch', { method: 'POST', body: JSON.stringify({ link: 'https://click.digital.endesaclientes.com/?qs=abc' }) });
  const body = await r.json();
  assert.equal(r.status, 201, JSON.stringify(body));
  assert.equal(body.invoice_no, 'P26CON046489044');
  assert.equal(body.total, '70,48 €');
  assert.ok(ctx.svc.getBill(body.bill_id).pdf_path);
  r = await api('/endesa/fetch', { method: 'POST', body: JSON.stringify({ link: 'https://click.digital.endesaclientes.com/?qs=abc' }) });
  assert.equal(r.status, 409);
});
