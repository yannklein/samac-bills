import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { parseEndesaBill } from '../src/parseEndesaBill.js';

const sample = readFileSync(new URL('./fixtures/endesa_oct_2026_detalle.txt', import.meta.url), 'utf8');
let dir, server, base, ctx;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'samac-admin-'));
  ctx = createApp({
    dataDir: dir, publicUrl: 'https://bills.example', adminEmail: 'yann@example.com', apiToken: 't',
    endesaNie: '', devUserEmail: 'yann@example.com', cfTeamDomain: '', cfAud: '', n8nSendWebhookUrl: '', n8nWebhookToken: '',
  });
  const ins = ctx.db.prepare('INSERT INTO people (role, name, wa_phone, email) VALUES (?, ?, ?, ?)');
  ins.run('yann', 'Yann', '34600000001', 'yann@example.com');
  ins.run('marcela', 'Marcela', '34600000003', 'marcela@example.com');
  ctx.db.prepare(`INSERT INTO readings (bill_id, reading_kwh, source, status) VALUES (NULL, 1000, 'seed', 'seed')`).run();
  await new Promise((r) => { server = ctx.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const form = (url, data, as) => fetch(`${base}${url}${as ? `?as=${as}` : ''}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data).toString(),
});
const newBill = (invoiceNo, periodTo) => {
  const parsed = { ...parseEndesaBill(sample), invoiceNo, periodTo };
  return ctx.svc.createBill({ parsed, pdfBuffer: Buffer.from('%PDF-1.4 x'), source: 'auto' }).bill;
};

test('admin pages are Yann-only', async () => {
  assert.equal((await fetch(`${base}/admin`)).status, 200);
  assert.equal((await fetch(`${base}/admin?as=marcela@example.com`)).status, 403);
  assert.equal((await form('/admin/people', { role: 'marcela', name: 'Hacked' }, 'marcela@example.com')).status, 403);
});

test('people: add, edit, validate, remove (never Yann)', async () => {
  let r = await form('/admin/people', { role: 'neighbor', name: 'Pepe', wa_phone: '+34 611 22 33 44', email: 'Pepe@Example.com' });
  assert.equal(r.status, 302);
  assert.deepEqual(ctx.svc.people().neighbor, { role: 'neighbor', name: 'Pepe', wa_phone: '34611223344', email: 'pepe@example.com' });
  r = await form('/admin/people', { role: 'neighbor', name: 'Pepe', wa_phone: '123' });
  assert.equal(r.status, 422);
  assert.equal((await form('/admin/people/yann/delete', {})).status, 422);
  assert.equal((await form('/admin/people/neighbor/delete', {})).status, 302);
  assert.equal(ctx.svc.people().neighbor, undefined);
  const page = await (await fetch(`${base}/admin`)).text();
  assert.match(page, /Neighbor[\s\S]*not set/);
});

test('edit bill: lines and total change, split recalculated and still adds up', async () => {
  const bill = newBill('EDIT1', '2026-11-01');
  ctx.svc.confirm(bill.id, { reading: 1100, source: 'manual', override: true });
  ctx.svc.markSent(bill.id);
  const items = ctx.svc.getBill(bill.id).items;
  const data = new URLSearchParams({
    invoice_no: 'EDIT1', period_from: '2026-10-07', period_to: '2026-11-01', days: '26', issued_at: '2026-11-06',
    kwh_total: '233.251', total: '80.48',
  });
  for (const it of items) {
    data.append('line_label', it.label);
    data.append('line_key', it.key);
    data.append('line_kind', it.kind);
    data.append('line_amount', (it.amountCents / 100).toFixed(2));
  }
  data.append('line_label', 'Extra service'); data.append('line_key', ''); data.append('line_kind', 'fixed'); data.append('line_amount', '10.00');
  data.append('line_label', ''); data.append('line_key', ''); data.append('line_kind', 'fixed'); data.append('line_amount', ''); // blank row ignored
  const r = await fetch(`${base}/bills/${bill.id}/edit`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data.toString() });
  assert.equal(r.status, 302, await r.text());
  const d = ctx.svc.billDetail(bill.id);
  assert.equal(d.bill.total_cents, 8048);
  assert.equal(d.bill.status, 'ready', 'amounts changed: must be re-sent');
  assert.equal(d.split.neighbor_cents + d.split.home_cents, 8048);
  assert.equal(d.split.neighbor_kwh, 100, 'reading kept');
  assert.equal(d.split.sent_at, null);

  // Lines that don't add up are refused
  data.set('total', '99.99');
  const bad = await fetch(`${base}/bills/${bill.id}/edit`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data.toString() });
  assert.equal(bad.status, 422);
  assert.equal(ctx.svc.getBill(bill.id).total_cents, 8048);
});

test('changing the previous reading recalculates unsent bills only', async () => {
  ctx.db.exec('DELETE FROM payments; DELETE FROM splits; DELETE FROM readings WHERE bill_id IS NOT NULL; DELETE FROM bills;');
  const sent = newBill('SEED-SENT', '2026-09-01');
  ctx.svc.confirm(sent.id, { reading: 1100, source: 'manual', override: true });
  ctx.svc.markSent(sent.id);
  const r = await form('/admin/seed', { reading: '1.050' });
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), /already sent: SEED-SENT/);
  assert.equal(ctx.svc.billDetail(sent.id).split.neighbor_kwh, 100, 'sent bill untouched');

  ctx.db.exec('DELETE FROM payments; DELETE FROM splits; DELETE FROM readings WHERE bill_id IS NOT NULL; DELETE FROM bills;');
  const open = newBill('SEED-OPEN', '2026-10-01');
  ctx.svc.confirm(open.id, { reading: 1100, source: 'manual', override: true });
  const r2 = await form('/admin/seed', { reading: '1050' });
  assert.match(decodeURIComponent(r2.headers.get('location')), /Recalculated: SEED-OPEN/);
  assert.equal(ctx.svc.billDetail(open.id).split.neighbor_kwh, 50);
});

test('mark as sent and delete a bill (with its files)', async () => {
  const bill = newBill('DEL1', '2026-12-01');
  ctx.svc.confirm(bill.id, { neighborKwh: 10, source: 'manual', override: true });
  assert.equal((await form(`/bills/${bill.id}/mark-sent`, {})).status, 302);
  assert.equal(ctx.svc.getBill(bill.id).status, 'sent');
  const pdf = path.join(ctx.svc.filesDir, ctx.svc.getBill(bill.id).pdf_path);
  assert.ok(existsSync(pdf));
  assert.equal((await form(`/bills/${bill.id}/delete`, {})).status, 302);
  assert.throws(() => ctx.svc.getBill(bill.id), /not found/);
  assert.equal(existsSync(pdf), false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM readings WHERE bill_id = ?').get(bill.id).n, 0);
});

test('backup downloads a SQLite database', async () => {
  const r = await fetch(`${base}/admin/backup`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="?samac-bills-[\d-]+\.db"?/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await fetch(`${base}/admin/backup?as=marcela@example.com`)).status, 403);
});

test('edit page and bill page render admin controls', async () => {
  const bill = newBill('VIEW1', '2027-01-01');
  const edit = await (await fetch(`${base}/bills/${bill.id}/edit`)).text();
  assert.match(edit, /Edit bill VIEW1/);
  assert.match(edit, /name="line_amount"/);
  const page = await (await fetch(`${base}/bills/${bill.id}`)).text();
  assert.match(page, /Edit bill details and lines/);
  assert.match(page, /Delete this bill/);
  const asMarcela = await (await fetch(`${base}/bills/${bill.id}?as=marcela@example.com`)).text();
  assert.doesNotMatch(asMarcela, /Delete this bill/);
});
